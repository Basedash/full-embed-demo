# Basedash embedding test

A test harness for the Basedash JWT-based full-app embedding feature. This Bun app provides a setup form to create organizations and connect data sources via the public API, then generates JWT tokens and loads Basedash in an iframe to test the SSO authentication flow.

## Prerequisites

Before running this test app, ensure:

1. **Basedash is running locally** on `http://localhost:3000`
2. **You have a valid API key** (generate one in Basedash settings)

## Setup

1. Install dependencies:

```bash
bun install
```

2. Run the dev server:

```bash
bun run dev
```

3. Open http://localhost:3001 in your browser

4. Fill out the setup form:
   - **API key**: Your Basedash API key (starts with `bd_key_`)
   - **JWT secret**: A secret string for signing embed tokens (will be saved to the organization)
   - **Organization name**: Name for the new organization
   - **Connection URI**: Database connection string (e.g., `postgresql://user:pass@host:5432/db`)
   - **Display name**: Human-readable name for the data source

5. Click "Create org and connect" to:
   - Create a new organization via the public API
   - Configure the JWT secret for embedding
   - Connect your data source
   - Automatically load the embedded Basedash

## How it works

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   Browser (:3001)   │     │   Bun Server        │     │  Basedash (:3000)   │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
         │                           │                           │
         │  Fill setup form          │                           │
         │                           │                           │
         │  POST /api/setup          │                           │
         │ ─────────────────────────>│                           │
         │                           │  POST /api/public/organizations
         │                           │ ─────────────────────────>│
         │                           │  { id, slug }             │
         │                           │ <─────────────────────────│
         │                           │                           │
         │                           │  PATCH /api/public/organizations/:id
         │                           │ ─────────────────────────>│
         │                           │  (set jwtSecret)          │
         │                           │ <─────────────────────────│
         │                           │                           │
         │                           │  POST /api/public/data-sources
         │                           │ ─────────────────────────>│
         │                           │  { id, displayName }      │
         │                           │ <─────────────────────────│
         │                           │                           │
         │  { orgId, dataSourceId }  │                           │
         │ <─────────────────────────│                           │
         │                           │                           │
         │  POST /api/generate-jwt   │                           │
         │ ─────────────────────────>│                           │
         │  { jwt, ssoUrl }          │                           │
         │ <─────────────────────────│                           │
         │                           │                           │
         │  Load iframe: /api/sso/jwt?jwt=XXX                    │
         │ ─────────────────────────────────────────────────────>│
         │                           │     Verify JWT, set cookie│
         │  Redirect to org home     │                           │
         │ <─────────────────────────────────────────────────────│
```

## Endpoints

| Endpoint                 | Method | Description                          |
| ------------------------ | ------ | ------------------------------------ |
| `GET /`                  | GET    | Main page with setup form and iframe |
| `POST /api/setup`        | POST   | Create org and connect data source   |
| `POST /api/generate-jwt` | POST   | Generate a signed JWT for embedding  |
| `GET /api/config`        | GET    | Get server configuration             |

## Supported connection URIs

The setup form parses standard database connection URIs:

| Database   | URI format                                    |
| ---------- | --------------------------------------------- |
| PostgreSQL | `postgresql://user:pass@host:5432/database`   |
| MySQL      | `mysql://user:pass@host:3306/database`        |
| ClickHouse | `clickhouse://user:pass@host:8443/database`   |
| SQL Server | `sqlserver://user:pass@host:1433?database=db` |

Special detection:

- URIs containing "supabase" are detected as Supabase
- URIs containing "planetscale", "pscale", or "psdb" are detected as PlanetScale

## Persistence

The following values are saved to localStorage and restored on page refresh:

- API key (`basedash-embed-api-key`)
- JWT secret (`basedash-embed-jwt-secret`)
- Organization ID (`basedash-embed-org-id`)

## JWT claims

The generated JWT includes the following claims:

```json
{
	"email": "embed-test@example.com",
	"orgId": "org_xxxxxxxxxxxx",
	"firstName": "Embed",
	"lastName": "Tester",
	"iat": 1234567890,
	"exp": 1234568490
}
```

JWTs expire after 10 minutes. Click "Refresh embed" to generate a new token.

## Troubleshooting

### "Embedding is not enabled for this organization"

Enable embedding for the organization using the public API:

```bash
curl -X PATCH http://localhost:3000/api/public/organizations/org_xxxxxxxxxxxx \
  -H "Authorization: Bearer bd_key_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"fullEmbedEnabled": true}'
```

### "Invalid or expired JWT"

- Ensure the JWT secret in the form matches what's stored in the org's `jwtSecret`
- JWT may have expired (10 minute lifetime) - click "Refresh embed"

### "Request origin not allowed"

If the organization has `embedAllowedOrigins` configured, add `http://localhost:3001` using the public API:

```bash
curl -X PATCH http://localhost:3000/api/public/organizations/org_xxxxxxxxxxxx \
  -H "Authorization: Bearer bd_key_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"embedAllowedOrigins": ["http://localhost:3001"]}'
```

Or clear the allowed origins to allow any origin during testing:

```bash
curl -X PATCH http://localhost:3000/api/public/organizations/org_xxxxxxxxxxxx \
  -H "Authorization: Bearer bd_key_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"embedAllowedOrigins": []}'
```
