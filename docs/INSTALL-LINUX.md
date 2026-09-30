# Installing GoPieNg on Debian 12/13

This guide installs GoPieNg on Debian 12 (Bookworm) or Debian 13 (Trixie) with PostgreSQL and nginx. GoPieNg serves the web UI from embedded assets, so no Node.js or frontend build step is required.

## 1. Install packages

Install Git, PostgreSQL, nginx, and the Go toolchain:

```sh
sudo apt update
sudo apt install -y git golang postgresql postgresql-client nginx ca-certificates
```

GoPieNg's `go.mod` requires Go 1.22.3 or newer. Verify the packaged version before building:

```sh
go version
```

If the installed Go version is older than 1.22.3, install a current Go release before continuing.

## 2. Create the PostgreSQL database

Create a dedicated database role and database. Replace `CHANGE_ME_DATABASE_PASSWORD` with a strong password:

```sh
sudo -u postgres psql
```

At the PostgreSQL prompt:

```sql
CREATE ROLE pieng LOGIN PASSWORD 'CHANGE_ME_DATABASE_PASSWORD';
CREATE DATABASE pieng OWNER pieng;
\q
```

## 3. Obtain and build GoPieNg

The examples below install the source in `/opt/gopieng` and the executable in `/usr/local/bin`.

```sh
sudo git clone https://github.com/yellowman/GoPieNg.git /opt/gopieng
cd /opt/gopieng
sudo go build -o /usr/local/bin/gopieng ./cmd/server
sudo chmod 0755 /usr/local/bin/gopieng
```

Initialize the database schema:

```sh
psql 'postgres://pieng:CHANGE_ME_DATABASE_PASSWORD@127.0.0.1:5432/pieng?sslmode=disable' \
  -f /opt/gopieng/schema.sql
```

## 4. Create the service account

Create an unprivileged system account. The application can run directly as this user when using its standalone HTTP mode.

```sh
sudo adduser --system --group --no-create-home --home /nonexistent gopieng
```

## 5. Configure GoPieNg

Generate a JWT signing secret of at least 32 characters:

```sh
openssl rand -hex 32
```

Create `/etc/gopieng.env`:

```sh
sudo install -m 0600 -o root -g root /dev/null /etc/gopieng.env
sudo editor /etc/gopieng.env
```

Example:

```text
PIENG_DSN=postgres://pieng:CHANGE_ME_DATABASE_PASSWORD@127.0.0.1:5432/pieng?sslmode=disable
PIENG_JWT_SECRET=REPLACE_WITH_THE_GENERATED_SECRET
PIENG_ADDR=127.0.0.1:8080
PIENG_TRUSTED_PROXIES=127.0.0.1/32
```

Keep this file readable only by root because it contains database credentials and the JWT signing secret. systemd reads `EnvironmentFile=` during service setup and supplies those values to the process before applying `User=gopieng`, so the service account does not need direct read access to `/etc/gopieng.env`.

## 6. Create the systemd service

Create `/etc/systemd/system/gopieng.service`:

```ini
[Unit]
Description=GoPieNg IP Address Management
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=gopieng
Group=gopieng
EnvironmentFile=/etc/gopieng.env
ExecStart=/usr/local/bin/gopieng -web
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Load and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gopieng
sudo systemctl status gopieng
```

Test the application locally:

```sh
curl http://127.0.0.1:8080/health
```

A healthy installation returns:

```text
ok
```

View service logs with:

```sh
sudo journalctl -u gopieng
```

## 7. Configure nginx

GoPieNg can serve its embedded frontend itself. nginx only needs to reverse proxy the application and terminate TLS.

Create `/etc/nginx/sites-available/gopieng`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name ipam.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and verify the configuration:

```sh
sudo ln -s /etc/nginx/sites-available/gopieng /etc/nginx/sites-enabled/gopieng
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Configure TLS before exposing the installation to untrusted networks. Your normal ACME/certificate tooling can be used with nginx.

## 8. Create the first administrator

GoPieNg does not create a default administrator account in `schema.sql`. For a fresh installation, generate a password hash with GoPieNg's own `auth.HashPassword` implementation, then insert the user and administrator role.

Create a temporary bootstrap program outside the repository:

```sh
mkdir -p /tmp/gopieng-bootstrap
cat >/tmp/gopieng-bootstrap/main.go <<'EOF'
package main

import (
    "fmt"
    "io"
    "log"
    "os"

    "github.com/yellowman/GoPieNg/internal/auth"
)

func main() {
    input, err := io.ReadAll(os.Stdin)
    if err != nil {
        log.Fatal(err)
    }
    if len(input) == 0 {
        log.Fatal("input is required")
    }
    hash, err := auth.HashPassword(string(input))
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(hash)
}
EOF
```

Because Go's `internal` package rules require the helper to be inside the module tree, copy it temporarily into the checked-out source, run it, and remove it immediately:

```sh
sudo mkdir -p /opt/gopieng/cmd/bootstrap-admin
sudo cp /tmp/gopieng-bootstrap/main.go /opt/gopieng/cmd/bootstrap-admin/main.go
read -rsp 'Initial admin password: ' ADMIN_PASSWORD; echo
ADMIN_HASH=$(printf '%s' "$ADMIN_PASSWORD" | (cd /opt/gopieng && sudo go run ./cmd/bootstrap-admin))
unset ADMIN_PASSWORD
sudo rm -rf /opt/gopieng/cmd/bootstrap-admin /tmp/gopieng-bootstrap
```

Insert the administrator account using the generated Argon2id PHC hash. The `psql` variable syntax keeps the hash out of the SQL text:

```sh
psql 'postgres://pieng:CHANGE_ME_DATABASE_PASSWORD@127.0.0.1:5432/pieng?sslmode=disable' \
  --set=admin_hash="$ADMIN_HASH" <<'SQL'
INSERT INTO users (username, password, status)
VALUES ('admin', :'admin_hash', 1)
ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, status = 1;

INSERT INTO user_roles ("user", role)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.username = 'admin'
  AND r.name = 'administrator'
ON CONFLICT DO NOTHING;
SQL
unset ADMIN_HASH
```

Do not insert a plaintext password into the `users.password` column. If you are migrating an existing PieNg database, supported legacy password hashes can instead be retained and are upgraded after a successful login.

## 9. Firewall

Only the reverse proxy needs to be reachable externally. Leave GoPieNg bound to `127.0.0.1:8080`. Permit TCP 80/443 as appropriate for your environment and do not expose PostgreSQL unless remote database access is specifically required.

## 10. Updating GoPieNg

Before an upgrade, back up PostgreSQL:

```sh
sudo sh -c 'sudo -u postgres pg_dump -Fc pieng > /root/pieng-$(date +%F).dump'
```

Then update and rebuild:

```sh
cd /opt/gopieng
sudo git pull --ff-only
sudo go build -o /usr/local/bin/gopieng ./cmd/server
sudo systemctl restart gopieng
```

Review `schema.sql`, `README.md`, and files under `docs/` for migration notes before upgrading an existing installation.

## Alternative: FastCGI

GoPieNg also supports FastCGI over a Unix or TCP socket. For most new Debian installations, standalone HTTP on loopback behind nginx is simpler. If FastCGI is required, see the FastCGI and nginx examples in the project `README.md`.
