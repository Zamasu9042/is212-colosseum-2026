# is212-colosseum-2026

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 14+ (running locally, in Docker, or a hosted instance)
- Git

### 1. Clone and install dependencies

```bash
git clone <your-repo-url>
cd task1-db-auth
npm install
```

### 2. Set up PostgreSQL

Create an empty database for the project:

```bash
# using psql
createdb connectsphere

# or from inside psql
psql -U postgres -c "CREATE DATABASE connectsphere;"
```

**Using Docker instead?**

```bash
docker run --name connectsphere-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=connectsphere \
  -p 5432:5432 -d postgres:16
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env`:

- Update `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` to match your PostgreSQL setup.
- Replace `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` with your own long, random strings (e.g. run `openssl rand -hex 32` twice). **Never commit real secrets.**

### 4. Initialise the database

```bash
npm run db:init    # applies the schema (tables, constraints, triggers)
npm run db:seed    # inserts the 5 system roles
```

> Need to start over during development? `npm run db:reset` drops and rebuilds everything (blocked automatically if `NODE_ENV=production`).

### 5. Run the server

```bash
npm run dev     # with auto-reload (nodemon)
# or
npm start       # plain node
```

The API will be available at `http://localhost:4000` (or whatever `PORT` you set). Confirm it's up:

```bash
curl http://localhost:4000/health
# {"status":"ok"}
```

### 6. Try the auth flow

```bash
# Register an Event Organiser
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"organiser@example.com","password":"Passw0rd1","firstName":"Jane","lastName":"Tan","role":"event_organiser"}'

# Log in
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"organiser@example.com","password":"Passw0rd1"}'
# → returns an accessToken; use it as: Authorization: Bearer <token>
```

### 7. Run the tests

```bash
npm test
```

### Troubleshooting

| Problem | Fix |
|---|---|
| `Unable to connect to the database` on startup | Check PostgreSQL is running and `.env` DB credentials are correct |
| `relation "roles" does not exist` | Run `npm run db:init` before `npm run db:seed` |
| `401 Unauthorized` on every request | Make sure you're sending `Authorization: Bearer <accessToken>` — access tokens expire after 15 min by default; use `/api/auth/refresh` to get a new one |
| bcrypt fails to install | Ensure build tools are present (`build-essential`/Xcode CLI tools) since it compiles a native module |