# Installing and Upgrading GoPieNg on OpenBSD with nginx and FastCGI

This guide documents a production deployment of GoPieNg on OpenBSD using nginx for the frontend and GoPieNg in FastCGI API-only mode over a Unix socket. It complements `INSTALL-OPENBSD.md`, which documents the base-system `httpd(8)` deployment.

In this layout, nginx serves the frontend directly from `/var/www/pieng/web/`, while GoPieNg handles API requests through `/var/www/run/gopieng.sock`. Installing a new GoPieNg binary does **not** update the production frontend; the binary and `web/` tree must be deployed together from the same source revision.

The examples below use:

```text
Source checkout:     /opt/gopieng/GoPieNg
Installed binary:    /usr/local/bin/gopieng
Build artifact:      /tmp/gopieng-new
Frontend:            /var/www/pieng/web
FastCGI socket:      /var/www/run/gopieng.sock
Environment:         /etc/gopieng.env
Wrapper:             /usr/local/sbin/gopieng-wrapper
rc.d service:        /etc/rc.d/gopieng
Web server:          nginx
```

Adjust hostnames and paths as required.

## 1. Build GoPieNg

Build as an unprivileged user rather than with `doas`. On a Git checkout where VCS metadata cannot be embedded, use `-buildvcs=false`:

```sh
cd /opt/gopieng/GoPieNg
git status --short
git log -1 --oneline

rm -f /tmp/gopieng-new
go build -buildvcs=false -o /tmp/gopieng-new ./cmd/server
```

Verify the artifact:

```sh
ls -lh /tmp/gopieng-new
file /tmp/gopieng-new
/tmp/gopieng-new -h 2>&1
sha256 /tmp/gopieng-new
```

Do not install the new binary until the database and currently deployed application have been backed up.

## 2. Configure persistent daemon credentials

Do not generate the JWT signing secret in the rc.d script. A newly generated secret on every restart invalidates all existing JWTs.

Create a persistent root-only environment file:

```sh
doas install -m 0600 -o root -g wheel /dev/null /etc/gopieng.env
doas vi /etc/gopieng.env
```

It must contain at least:

```text
PIENG_DSN=postgres://pieng:CHANGE_ME_DATABASE_PASSWORD@127.0.0.1/pieng?sslmode=disable
PIENG_JWT_SECRET=REPLACE_WITH_A_PERSISTENT_SECRET
```

Generate a suitable JWT secret with:

```sh
openssl rand -hex 32
```

Keep `/etc/gopieng.env` mode `0600` and owned by `root:wheel`. Do not put the database password or JWT secret directly in the rc.d script, shell history, or a world-readable file.

Create the wrapper:

```sh
doas tee /usr/local/sbin/gopieng-wrapper >/dev/null <<'EOF'
#!/bin/ksh

set -a
. /etc/gopieng.env
set +a

exec /usr/local/bin/gopieng "$@"
EOF

doas chown root:wheel /usr/local/sbin/gopieng-wrapper
doas chmod 0500 /usr/local/sbin/gopieng-wrapper
```

A separate temporary file used only to generate the JWT secret is unnecessary after the secret has been stored in `/etc/gopieng.env`.

## 3. Prepare the FastCGI socket directory

```sh
doas mkdir -p /var/www/run
doas chown root:www /var/www/run
doas chmod 0775 /var/www/run
```

GoPieNg creates `/var/www/run/gopieng.sock` before dropping privileges. The socket group defaults to `www` unless overridden by `PIENG_SOCKET_GROUP`.

## 4. Configure rc.d

Create `/etc/rc.d/gopieng`:

```sh
#!/bin/ksh

daemon="/usr/local/sbin/gopieng-wrapper"
daemon_flags="-d -no-static -socket /var/www/run/gopieng.sock"

. /etc/rc.d/rc.subr

# The wrapper execs /usr/local/bin/gopieng, so match the resulting
# GoPieNg process rather than the wrapper pathname.
pexp="/usr/local/bin/gopieng${daemon_flags:+ ${daemon_flags}}"

rc_bg=YES
rc_reload=NO

rc_cmd $1
```

Install the script with:

```sh
doas chown root:wheel /etc/rc.d/gopieng
doas chmod 0555 /etc/rc.d/gopieng
doas rcctl enable gopieng
```

The `-d` flag is intentional: GoPieNg remains in the foreground instead of self-daemonizing, while `rc_bg=YES` lets OpenBSD's standard `rc.subr` machinery background and supervise it. Do not add a custom `rc_start()`, manually append `&`, or use the `-P` PID-file option with this configuration.

Because the wrapper uses `exec`, `pexp` must match the resulting `/usr/local/bin/gopieng` command line rather than the wrapper pathname.

## 5. Configure nginx

A representative nginx configuration is:

```nginx
server {
    listen 443 ssl;
    server_name ipam.example.com;

    access_log /var/www/logs/pieng.access.log;
    error_log  /var/www/logs/pieng.error.log;

    location / {
        alias /var/www/pieng/web/;
        try_files $uri $uri/ /index.html;
    }

    location /api/pieng {
        fastcgi_pass unix:/var/www/run/gopieng.sock;
        include fastcgi_params;
    }
}
```

Preserve any site-specific TLS, headers, FastCGI parameters, and routing already required by the production nginx configuration. Validate nginx after configuration changes:

```sh
doas nginx -t
```

In this deployment GoPieNg is started with `-no-static`; nginx, not the Go process, serves the contents of `/var/www/pieng/web/`.

## 6. Validate rc.d service management

Before an application upgrade, verify that rc.d manages exactly one GoPieNg process.

Start and check:

```sh
doas rcctl start gopieng
doas rcctl check gopieng
pgrep -fl gopieng
ps axww -o pid,user,command | grep '[g]opieng'
ls -l /var/www/run/gopieng.sock
```

The process should resemble:

```text
/usr/local/bin/gopieng -d -no-static -socket /var/www/run/gopieng.sock
```

Test a restart:

```sh
doas rcctl restart gopieng
doas rcctl check gopieng
pgrep -fl gopieng
```

There should still be exactly one process and its PID should change.

Test a complete stop:

```sh
doas rcctl stop gopieng
doas rcctl check gopieng
pgrep -fl gopieng
```

After a successful stop, `rcctl check` reports the service as not running and `pgrep` returns no GoPieNg process. A Unix socket may remain after shutdown. GoPieNg can replace a stale socket on the next normal start, so manual socket deletion should not be part of the routine stop/start procedure.

Start it again:

```sh
doas rcctl start gopieng
doas rcctl check gopieng
```

## 7. Pre-upgrade database backup

Create a protected backup directory:

```sh
doas mkdir -p /var/backups/gopieng
doas chmod 0700 /var/backups/gopieng
```

Use the existing root-only environment file so the database password is not copied into shell history:

```sh
doas sh -c '
set -a
. /etc/gopieng.env
set +a

umask 077
pg_dump --format=custom \
    --file=/var/backups/gopieng/pieng-pre-upgrade-$(date +%Y%m%d).dump \
    "$PIENG_DSN"
'
```

Verify that the archive exists and that `pg_restore` can read its catalog:

```sh
doas ls -lh /var/backups/gopieng/pieng-pre-upgrade-*.dump
doas pg_restore --list /var/backups/gopieng/pieng-pre-upgrade-YYYYMMDD.dump | head -20
```

Do not proceed with an upgrade unless the backup is readable.

## 8. Back up the deployed binary and frontend

Use a date appropriate to the deployment:

```sh
doas cp -p /usr/local/bin/gopieng \
    /usr/local/bin/gopieng.pre-YYYYMMDD

doas rm -rf /var/www/pieng/web.pre-YYYYMMDD
doas cp -Rp /var/www/pieng/web \
    /var/www/pieng/web.pre-YYYYMMDD
```

Verify the binary backup:

```sh
sha256 /usr/local/bin/gopieng \
       /usr/local/bin/gopieng.pre-YYYYMMDD
```

The hashes must match.

At this point there should be three independent rollback artifacts: a PostgreSQL dump, the previously installed executable, and the previously deployed frontend.

## 9. Stop the application for deployment

```sh
doas rcctl stop gopieng
doas rcctl check gopieng
pgrep -fl gopieng
```

Do not continue until no GoPieNg process remains.

The FastCGI socket may remain on disk after shutdown. That is acceptable and does not normally need to be removed.

## 10. Install the new backend

Install the previously verified build artifact:

```sh
doas install -o root -g wheel -m 0755 \
    /tmp/gopieng-new /usr/local/bin/gopieng
```

Verify that the installed binary is byte-for-byte identical to the build artifact:

```sh
sha256 /tmp/gopieng-new /usr/local/bin/gopieng
```

The two hashes must match.

Do not start GoPieNg yet. Deploy the matching frontend first.

## 11. Deploy the matching frontend

The frontend must come from the same source revision used to build `/tmp/gopieng-new`.

From the repository root:

```sh
cd /opt/gopieng/GoPieNg

doas rm -rf /var/www/pieng/web
doas cp -Rp ./web /var/www/pieng/web

doas chown -R root:wheel /var/www/pieng/web
doas find /var/www/pieng/web -type d -exec chmod 0755 {} \;
doas find /var/www/pieng/web -type f -exec chmod 0644 {} \;
```

Replacing the complete directory is preferable to copying `web/*` over the existing tree: obsolete files cannot survive the deployment, and hidden files are not omitted.

## 12. Start and verify the upgraded application

Start GoPieNg:

```sh
doas rcctl start gopieng
```

Verify process supervision and socket creation:

```sh
doas rcctl check gopieng
pgrep -fl gopieng
ps axww -o pid,user,command | grep '[g]opieng'
ls -l /var/www/run/gopieng.sock
```

There should be exactly one GoPieNg process.

Exercise the actual nginx -> FastCGI -> GoPieNg -> PostgreSQL path:

```sh
curl -i https://ipam.example.com/api/pieng/ping
```

A healthy response is HTTP 200 with JSON containing `"status":"ok"`.

Also verify the frontend:

```sh
curl -I https://ipam.example.com/
```

Then use a browser to perform a hard refresh or open a private window and verify login, navigation, and the UI functionality introduced by the release.

## 13. Authentication considerations

Legacy supported password hashes can be upgraded to Argon2id after a successful login. Therefore an apparently simple authentication test may modify the database. This is another reason the PostgreSQL backup must be made before the new application is exercised.

After changing from a per-start JWT secret to the persistent `PIENG_JWT_SECRET`, JWTs issued using the old secret will no longer validate. Users may need to log in once after the migration. Subsequent ordinary service restarts will retain the same signing secret and should not invalidate tokens solely because GoPieNg restarted.

For an upgrade, test at least:

- normal login and logout;
- a second login after logout;
- administrator user management, if applicable;
- self-service password-change UI without necessarily submitting a change; and
- any release-specific frontend behavior.

## 14. Check logs

Inspect nginx after the deployment:

```sh
doas tail -50 /var/www/logs/pieng.error.log
doas tail -50 /var/www/logs/pieng.access.log
```

Also inspect the system daemon log used by the OpenBSD installation.

Look for FastCGI connection failures, socket permission errors, database errors, unexpected authentication failures, and HTTP 5xx responses.

## 15. Final restart test

Once the upgraded application is working, verify that the new executable also behaves correctly under rc.d:

```sh
doas rcctl restart gopieng
doas rcctl check gopieng
pgrep -fl gopieng
curl -i https://ipam.example.com/api/pieng/ping
```

There should be exactly one GoPieNg process and the API should return successfully.

## 16. Rollback

If the new application fails, stop it first:

```sh
doas rcctl stop gopieng
```

Restore the previous executable:

```sh
doas cp -p /usr/local/bin/gopieng.pre-YYYYMMDD \
    /usr/local/bin/gopieng
```

Restore the previous frontend:

```sh
doas rm -rf /var/www/pieng/web
doas cp -Rp /var/www/pieng/web.pre-YYYYMMDD \
    /var/www/pieng/web
```

Start and test:

```sh
doas rcctl start gopieng
doas rcctl check gopieng
curl -i https://ipam.example.com/api/pieng/ping
```

### Database rollback

Do **not** automatically restore PostgreSQL merely because the binary or frontend is rolled back.

A database restore discards database changes made after the backup. Restore the pre-upgrade database only when the upgrade made database changes that are incompatible with the old application or when reverting those changes is explicitly required.

Before any database restore, stop GoPieNg and preserve the current database state with an additional dump when possible. Review the upgrade's schema and authentication changes before deciding to restore.

The pre-upgrade custom-format archive can be inspected with:

```sh
doas pg_restore --list /var/backups/gopieng/pieng-pre-upgrade-YYYYMMDD.dump
```

Database restoration is intentionally not automated by this guide.

## 17. Post-upgrade cleanup

Keep the database, binary, and frontend rollback artifacts until the upgraded application has operated normally for an appropriate period.

If a separate temporary JWT-secret file was used while setting up `/etc/gopieng.env`, remove it after confirming the persistent secret is safely stored:

```sh
doas rm -f /etc/gopieng.jwt
```

The old `/var/run/gopieng.pid` file is not used by this rc.d design and should not be recreated. Once no old daemon is using it, a stale file can be removed:

```sh
doas rm -f /var/run/gopieng.pid
```

If credentials were exposed during installation or troubleshooting, rotate them after the service is stable. Update `PIENG_DSN` in `/etc/gopieng.env` without placing the password in shell history, then restart GoPieNg and verify the API.

## Deployment checklist

A production upgrade follows this sequence:

```text
1. Update and verify the source checkout.
2. Build ./cmd/server as an unprivileged user.
3. Verify the new binary.
4. Back up PostgreSQL and validate the dump.
5. Back up the installed binary.
6. Back up the deployed frontend.
7. Stop GoPieNg and verify no process remains.
8. Install the new binary.
9. Deploy the matching web/ tree.
10. Start GoPieNg.
11. Verify rc.d, process count, socket, API, frontend, and authentication.
12. Inspect logs.
13. Restart once and re-test.
14. Retain rollback artifacts until the deployment is proven stable.
15. Perform post-upgrade credential and stale-file cleanup when appropriate.
```
