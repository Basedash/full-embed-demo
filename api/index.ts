import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { SignJWT } from 'jose';

const app = new Hono();

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * The base URL of the Basedash app.
 * Default is localhost:3000 for local development.
 * Set BASEDASH_URL environment variable to override.
 */
const BASEDASH_URL = process.env.BASEDASH_URL || 'http://localhost:3000';

// =============================================================================
// Dummy user data for testing
// =============================================================================

const DUMMY_USER = {
	email: 'embed-test@example.com',
	firstName: 'Embed',
	lastName: 'Tester',
};

// =============================================================================
// Connection URI Parsing
// =============================================================================

/**
 * Regular expression for parsing database connection URIs.
 * Based on the pattern from the main Basedash codebase.
 * Format: [dialect]://[username[:password]@][host][:port][/database][?params]
 */
const connectionUriRegex = new RegExp(
	[
		'^',
		'(?<dialect>[\\w:]+)', // dialect (supports jdbc:clickhouse)
		'://',
		'(?:',
		'(?<username>[^:@]*)', // username
		'(?::(?<password>[^@]*))?', // optional password
		'@',
		')?',
		'(?<host>(?:\\[[^\\]]+\\]|[^:/]+))', // hostname (IPv6 or regular)
		'(?::(?<port>\\d+))?', // optional port
		'(?:/(?<database>[\\w.-]*))?', // optional database
		'(?:\\?(?<params>[^#]*)?)?', // optional query params
		'(?:#.*)?',
		'$',
	].join(''),
);

type DatabaseDialect =
	| 'POSTGRES'
	| 'SUPABASE'
	| 'MYSQL'
	| 'PLANETSCALE'
	| 'CLICKHOUSE'
	| 'SQL_SERVER';

function extractDialectFromUri(value: string): DatabaseDialect | undefined {
	const match = value.match(connectionUriRegex);
	if (!match?.groups) return undefined;
	const dialect = match.groups.dialect ?? '';

	switch (dialect.toUpperCase()) {
		case 'POSTGRES':
		case 'POSTGRESQL': {
			if (value.toLowerCase().includes('supabase')) {
				return 'SUPABASE';
			}
			return 'POSTGRES';
		}
		case 'MYSQL': {
			if (
				value.toLowerCase().includes('planetscale') ||
				value.toLowerCase().includes('pscale') ||
				value.toLowerCase().includes('psdb')
			) {
				return 'PLANETSCALE';
			}
			return 'MYSQL';
		}
		case 'JDBC:CLICKHOUSE':
		case 'CLICKHOUSE':
			return 'CLICKHOUSE';
		case 'SQLSERVER':
		case 'MSSQL':
		case 'SQL_SERVER':
			return 'SQL_SERVER';
		default:
			return undefined;
	}
}

function safeDecodeURIComponent(str: string): string {
	try {
		return decodeURIComponent(str);
	} catch {
		return str;
	}
}

type ParsedCredentials = {
	username: string;
	password: string;
	host: string;
	port: number | undefined;
	databaseName: string;
	sslEnabled: boolean;
};

function extractCredentialsFromUri(
	value: string,
): ParsedCredentials | undefined {
	const match = value.match(connectionUriRegex);
	if (!match?.groups) return undefined;

	const rawUsername = match.groups.username ?? '';
	const rawPassword = match.groups.password ?? '';
	const host = match.groups.host ?? '';
	const port = match.groups.port ?? '';
	let databaseName = match.groups.database ?? '';
	const paramsRaw = match.groups.params ?? '';

	const username = rawUsername ? safeDecodeURIComponent(rawUsername) : '';
	let password = rawPassword ? safeDecodeURIComponent(rawPassword) : '';

	// Supabase placeholder handling
	if (password === '[YOUR-PASSWORD]') {
		password = '';
	}

	let portNumber: number | undefined = undefined;
	if (port) {
		portNumber = parseInt(port, 10);
	}

	// Parse query params for database name and SSL mode
	let sslEnabled = true;
	if (paramsRaw) {
		try {
			const params = new URLSearchParams(paramsRaw);

			// SQL Server may put database in query params
			if (!databaseName) {
				const dbFromParams = params.get('database');
				if (dbFromParams) {
					databaseName = dbFromParams;
				}
			}

			// Parse SSL mode from query params
			// Common param names: sslmode (Postgres), ssl-mode (MySQL), ssl
			const sslMode =
				params.get('sslmode') ?? params.get('ssl-mode') ?? params.get('ssl');
			if (sslMode) {
				// SSL is enabled for any mode except 'disable' or 'false'
				const normalizedMode = sslMode.toLowerCase();
				sslEnabled = normalizedMode !== 'disable' && normalizedMode !== 'false';
			}
		} catch {
			// ignore invalid params
		}
	}

	databaseName = databaseName ? safeDecodeURIComponent(databaseName) : '';

	return {
		username,
		password,
		host,
		port: portNumber,
		databaseName,
		sslEnabled,
	};
}

// =============================================================================
// JWT Generation
// =============================================================================

async function generateJwt(jwtSecret: string, orgId: string): Promise<string> {
	const secret = new TextEncoder().encode(jwtSecret);

	const jwt = await new SignJWT({
		email: DUMMY_USER.email,
		orgId: orgId,
		firstName: DUMMY_USER.firstName,
		lastName: DUMMY_USER.lastName,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(secret);

	return jwt;
}

// =============================================================================
// API Helpers
// =============================================================================

type SetupRequest = {
	apiKey: string;
	orgName: string;
	dataSourceUri: string;
	dataSourceName: string;
};

type ApiErrorResponse = {
	error: {
		title: string;
		detail: string;
	};
};

type CreateOrgResponse = {
	data: {
		id: string;
		slug: string;
		jwtSecret: string;
	};
};

type CreateDataSourceResponse = {
	data: {
		id: string;
		displayName: string;
	};
};

async function createOrganization(
	apiKey: string,
	orgName: string,
): Promise<{ id: string; slug: string; jwtSecret: string }> {
	const response = await fetch(`${BASEDASH_URL}/api/public/organizations`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: orgName,
			skipOnboarding: true,
			fullEmbedEnabled: true,
		}),
	});

	const responseData = (await response.json()) as
		| CreateOrgResponse
		| ApiErrorResponse;

	if (!response.ok) {
		const error = responseData as ApiErrorResponse;
		throw new Error(error.error?.detail ?? 'Failed to create organization');
	}

	const data = responseData as CreateOrgResponse;
	return {
		id: data.data.id,
		slug: data.data.slug,
		jwtSecret: data.data.jwtSecret,
	};
}

async function createDataSource(
	apiKey: string,
	orgId: string,
	displayName: string,
	dialect: DatabaseDialect,
	credentials: ParsedCredentials,
): Promise<{ id: string; displayName: string }> {
	const response = await fetch(`${BASEDASH_URL}/api/public/data-sources`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			type: 'direct',
			organizationId: orgId,
			displayName,
			dialect,
			host: credentials.host,
			port: credentials.port,
			databaseName: credentials.databaseName,
			username: credentials.username,
			password: credentials.password,
			sslEnabled: credentials.sslEnabled,
		}),
	});

	const responseData = (await response.json()) as
		| CreateDataSourceResponse
		| ApiErrorResponse;

	if (!response.ok) {
		const error = responseData as ApiErrorResponse;
		throw new Error(error.error?.detail ?? 'Failed to create data source');
	}

	const data = responseData as CreateDataSourceResponse;
	return { id: data.data.id, displayName: data.data.displayName };
}

// =============================================================================
// Routes
// =============================================================================

// Configuration endpoint
app.get('/api/config', (c) => {
	return c.json({ basedashUrl: BASEDASH_URL });
});

// Setup endpoint - creates org and data source
app.post('/api/setup', async (c) => {
	try {
		const body = (await c.req.json()) as SetupRequest;
		const { apiKey, orgName, dataSourceUri, dataSourceName } = body;

		// Validate inputs
		if (!apiKey || !orgName || !dataSourceUri) {
			return c.json({ error: 'Missing required fields' }, 400);
		}

		// Parse the connection URI
		const dialect = extractDialectFromUri(dataSourceUri);
		if (!dialect) {
			return c.json(
				{
					error:
						'Could not determine database type from URI. Supported: PostgreSQL, MySQL, ClickHouse, SQL Server',
				},
				400,
			);
		}

		const credentials = extractCredentialsFromUri(dataSourceUri);
		if (!credentials) {
			return c.json({ error: 'Could not parse connection URI' }, 400);
		}

		if (!credentials.host) {
			return c.json({ error: 'Host is required in connection URI' }, 400);
		}

		// Create organization (jwtSecret is auto-generated by the API)
		console.log(`Creating organization: ${orgName}`);
		const org = await createOrganization(apiKey, orgName);
		console.log(`Organization created: ${org.id}`);

		// Create data source
		console.log(`Creating data source: ${dataSourceName}`);
		const dataSource = await createDataSource(
			apiKey,
			org.id,
			dataSourceName || 'Connected Database',
			dialect,
			credentials,
		);
		console.log(`Data source created: ${dataSource.id}`);

		return c.json({
			orgId: org.id,
			orgSlug: org.slug,
			jwtSecret: org.jwtSecret,
			dataSourceId: dataSource.id,
			dataSourceName: dataSource.displayName,
		});
	} catch (error) {
		console.error('Setup failed:', error);
		const message = error instanceof Error ? error.message : 'Setup failed';
		return c.json({ error: message }, 500);
	}
});

// Generate JWT endpoint
app.post('/api/generate-jwt', async (c) => {
	try {
		const body = (await c.req.json()) as { jwtSecret: string; orgId: string };
		const { jwtSecret, orgId } = body;

		if (!jwtSecret || !orgId) {
			return c.json({ error: 'jwtSecret and orgId are required' }, 400);
		}

		const jwt = await generateJwt(jwtSecret, orgId);
		return c.json({
			jwt,
			ssoUrl: `${BASEDASH_URL}/api/sso/jwt?jwt=${jwt}`,
			user: DUMMY_USER,
			orgId,
			expiresIn: '10 minutes',
		});
	} catch (error) {
		console.error('Failed to generate JWT:', error);
		return c.json(
			{ error: 'Failed to generate JWT. Check your configuration.' },
			500,
		);
	}
});

// Legacy GET support for generate-jwt
app.get('/api/generate-jwt', async (c) => {
	try {
		const jwtSecret = c.req.query('jwtSecret') ?? '';
		const orgId = c.req.query('orgId') ?? '';

		if (!jwtSecret || !orgId) {
			return c.json({ error: 'jwtSecret and orgId are required' }, 400);
		}

		const jwt = await generateJwt(jwtSecret, orgId);
		return c.json({
			jwt,
			ssoUrl: `${BASEDASH_URL}/api/sso/jwt?jwt=${jwt}`,
			user: DUMMY_USER,
			orgId,
			expiresIn: '10 minutes',
		});
	} catch (error) {
		console.error('Failed to generate JWT:', error);
		return c.json(
			{ error: 'Failed to generate JWT. Check your configuration.' },
			500,
		);
	}
});

// Upload icon endpoint - proxies to Basedash API
app.post('/api/upload-icon', async (c) => {
	try {
		const apiKey = c.req.header('X-Api-Key');
		const orgId = c.req.header('X-Org-Id');

		if (!apiKey || !orgId) {
			return c.json(
				{ error: 'Missing required headers: X-Api-Key and X-Org-Id' },
				400,
			);
		}

		// Get the form data from the request
		const formData = await c.req.formData();
		const iconFile = formData.get('icon');

		if (!iconFile || !(iconFile instanceof File)) {
			return c.json({ error: 'Missing icon file' }, 400);
		}

		// Forward to Basedash API
		const uploadFormData = new FormData();
		uploadFormData.append('icon', iconFile);

		const response = await fetch(
			`${BASEDASH_URL}/api/public/organizations/${orgId}/icon`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
				body: uploadFormData,
			},
		);

		const responseData = await response.json();

		if (!response.ok) {
			return c.json(responseData, response.status as 400 | 500);
		}

		return c.json(responseData);
	} catch (error) {
		console.error('Icon upload failed:', error);
		const message =
			error instanceof Error ? error.message : 'Icon upload failed';
		return c.json({ error: message }, 500);
	}
});

// Serve static files from public directory
app.use('/*', serveStatic({ root: './public' }));

// Export for Vercel
export default app;
