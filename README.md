# GoPieNg - IP Address Management
![Screenshot](screenshot.png)

A modern, tree-based IPAM (IP Address Management) system with a Go backend and vanilla JavaScript frontend.

Derived from Tim Howe's PieNg. The original is at:
https://gitlab.com/thowe/MoPieNg

## Features

- Tree-based network browser - Expandable hierarchy, no page navigation needed
- Inline editing - Click any description or owner to edit it in place
- Smart allocation - Recommends larger blocks (green) vs smaller blocks (muted)
- Configurable allocation sizes - Administrators can edit allowed subnet masks per network
- Full audit trail - All changes logged with username and timestamp
- User management - Administrators can create/manage other users and assign roles
- Dark/light mode - Toggle in header, persists across sessions
- Browser history - Back/forward buttons work as expected

## Migration from PieNg

Follow migration comments in schema.sql

## Quick Start

```bash
# Set required environment variables
export PIENG_DSN='postgres://pieng:password@localhost:5432/pieng?sslmode=disable'
export PIENG_JWT_SECRET='your-secret-key-at-least-32-characters'

# Build
go build -o bin/pieng ./cmd/server

# Run as FastCGI (default) - for use behind nginx/httpd
./bin/pieng -socket /var/www/run/pieng.sock

# Or run as standalone HTTP server for development
./bin/pieng -web
# Open http://localhost:8080
```

## Server Modes

### FastCGI Server (Default)

For integration with nginx, httpd, or other web servers:

```bash
# Unix socket (recommended)
./bin/pieng -socket /var/www/run/pieng.sock

# TCP socket
./bin/pieng -addr 127.0.0.1:9000
PIENG_ADDR=127.0.0.1:9000 ./bin/pieng
```

### HTTP Server

For development or standalone deployment:

```bash
./bin/pieng -web                      # Listen on 127.0.0.1:8080
./bin/pieng -web -addr 0.0.0.0:8080   # Listen on all interfaces
PIENG_ADDR=:8080 ./bin/pieng -web     # Via environment
```

### API-Only Mode

Disable static file serving when using a separate web server for assets:

```bash
./bin/pieng -no-static -socket /var/www/run/pieng.sock
```

## nginx Configuration Example

```nginx
upstream pieng {
    server unix:/var/run/pieng.sock;
}

server {
    listen 443 ssl http2;
    server_name ipam.example.com;
    
    root /var/www/pieng/web;
    
    # Static files served by nginx
    location /css/ {
        expires 1h;
    }
    
    location /js/ {
        expires 1h;
    }
    
    # API via FastCGI
    location /api/pieng {
        include fastcgi_params;
        fastcgi_pass pieng;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
    
    # SPA - serve index.html for all other routes
    location / {
        try_files $uri /index.html;
    }
}
```

## OpenBSD httpd Configuration Example

```
server "ipam.example.com" {
    listen on * tls port 443
    root "/var/www/pieng/web"
    
    location "/api/pieng/*" {
        fastcgi socket "/var/run/pieng.sock"
    }
    
    location "/*.css" {
        pass
    }
    
    location "/*.js" {
        pass
    }
    
    location "/*" {
        request rewrite "/index.html"
    }
}
```

## Security

### Built-in Hardening

- Rate limiting: 100 requests/minute per IP (configurable)
- Request timeouts: 30 second maximum
- Security headers: X-Content-Type-Options, X-Frame-Options, etc.
- CORS: Disabled by default, configure via `PIENG_CORS_ORIGINS`
- Localhost binding: Default address is 127.0.0.1, not 0.0.0.0

### OpenBSD pledge(2)

On OpenBSD, the server automatically restricts itself using pledge:
- `stdio` - Basic I/O
- `rpath` - Read static files
- `inet` - Network connections
- `dns` - DNS resolution
- `unix` - Unix sockets (FastCGI)

### Recommendations

1. Run behind a reverse proxy (nginx, httpd)
2. Use TLS termination at the proxy
3. Set strong `PIENG_JWT_SECRET` (32+ characters)
4. Use Unix sockets for FastCGI (not TCP)
5. Run as unprivileged user
6. Use database connection pooling limits

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIENG_DSN` | required | PostgreSQL connection string |
| `PIENG_ADDR` | `127.0.0.1:8080` | Listen address |
| `PIENG_JWT_SECRET` | required | Secret for JWT signing (32+ chars) |
| `PIENG_CORS_ORIGINS` | (none) | Comma-separated allowed origins |

## Command Line Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-web` | false | Run as standalone HTTP server (default is FastCGI) |
| `-addr` | `$PIENG_ADDR` | Listen address |
| `-socket` | (none) | Unix socket path for FastCGI |
| `-no-static` | false | Disable static file serving |
| `-webroot` | `web` | Path to web directory |
| `-v` | false | Verbose logging (always enabled in `-web` mode) |

### User Management

User management is available in the UI under the Users tab (administrator only). You can:
- Create new users with username and password
- Assign roles during creation or change them later
- Enable/disable users
- Delete users

#### Roles

| Role | Permissions |
|------|-------------|
| `administrator` | Full access including user management and network settings |
| `creator` | Create/delete networks, plus all editor permissions |
| `editor` | Create/edit/delete hosts, edit network descriptions |
| `reader` | View only (default for users with no role) |

To grant administrator to an existing user via SQL:

```sql
-- Grant administrator role to existing user (adjust username as needed)
INSERT INTO user_roles ("user", role)
SELECT u.id, r.id FROM users u, roles r 
WHERE u.username = 'admin' AND r.name = 'administrator'
ON CONFLICT DO NOTHING;
```

### Expanding Allocation Options

The old PieNg stored allowed subnet masks in `valid_masks`. You can now edit
these through the web UI (click the gear icon on any subdividable network).

Or via SQL:

```sql
-- Allow /9 through /24 for a /8 network
UPDATE networks 
SET valid_masks = '{9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24}'
WHERE address_range = '10.0.0.0/8';

-- Clear valid_masks to auto-generate options (parent+1 to parent+8)
UPDATE networks SET valid_masks = NULL WHERE subdivide = true;
```

### Password Formats

Passwords can be stored as:
- `{SSHA}...` - SHA1 with salt (old format, still supported)
- `{SSHA256}...` - SHA256 with salt (recommended, used by UI)
- `{SSHA512}...` - SHA512 with salt

## Database Schema

See `schema.sql` for the complete database schema with comments and migration notes.

## API Endpoints

All endpoints require JWT authentication (except `/api/pieng/auth/login` and `/health`).

The default API base path is `/api/pieng`.

### Authentication
- `POST /api/pieng/auth/login` - Login, returns JWT token
- `GET /api/pieng/me` - Current user info

### Networks
- `GET /api/pieng/networks` - List networks (query params: `parent_id`, `q`)
- `GET /api/pieng/networks/{id}` - Get network details
- `PATCH /api/pieng/networks/{id}` - Update network (description, owner, valid_masks, etc.)
- `DELETE /api/pieng/networks/{id}` - Delete network
- `POST /api/pieng/networks/{id}/allocate-subnet` - Allocate subnet (body: `{mask, description}` or `{cidr, description, subdivide}`)

### Hosts
- `GET /api/pieng/networks/{id}/hosts` - List hosts in network
- `POST /api/pieng/networks/{id}/hosts` - Add/update host (body: `{address, description}`)
- `POST /api/pieng/networks/{id}/allocate-host` - Allocate next free host
- `DELETE /api/pieng/hosts/{ip}` - Delete host

### Users (administrator only)
- `GET /api/pieng/users` - List users with roles
- `POST /api/pieng/users` - Create user (body: `{username, password, roles}`)
- `PATCH /api/pieng/users/{id}` - Update user (password, status, roles)
- `DELETE /api/pieng/users/{id}` - Delete user

### System
- `GET /health` - Health check (returns "ok" if database is reachable)
- `GET /api/pieng/logs` - Activity log (query param: `limit`)

## UI Usage

### Network Tree
- Click the arrow to expand a network and see children
- Click open/close button to toggle expansion
- Click description text to edit inline
- Click owner field to edit inline
- Press Enter to save, Escape to cancel

### Configuring Allocation Sizes (Administrator)
- Click the gear icon on any subdividable network
- Check which sizes should be allowed
- Use "Common" to select /+1 through /+4
- Click Save

### Allocating Subnets
- Expand a subdivide network
- Enter description (optional)
- Click a size button:
  - Green buttons = recommended (larger blocks)
  - Gray buttons = smaller blocks (use sparingly)

### Managing Hosts
- Click "hosts" on a leaf network
- Enter IP (or leave blank for auto) and description
- Click Add
- Click description to edit
- Click del to delete

### User Management (Administrator)
- Go to Users tab (visible only to administrators)
- Add new users with username/password/role
- Change user roles via dropdown (administrator/creator/editor/reader)
- Enable/disable users
- Delete users

## Development

```bash
# Run HTTP server for development
go run ./cmd/server -web

# Or with live reload (requires air)
# Add "-web" to air's args in .air.toml
air

# Test FastCGI mode
go run ./cmd/server -addr :9000
```

Frontend files are in `web/`. No build step required - vanilla JavaScript with ES modules.

## License

MIT
