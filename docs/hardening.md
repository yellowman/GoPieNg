# Hardening upgrade and deployment notes

## Before deployment

Back up the database and run `psql "$PIENG_DSN" -f scripts/check-integrity.sql`
against a copy first. These are read-only checks; the daemon does not rewrite
legacy allocations. Correct inconsistent records before relying on allocation
policy enforcement. There is no new schema migration in this release. The
existing `schema.sql` migration that permits a nullable `changelog."user"` is
still required for account deletion; without it deletion fails and rolls back.

All users must sign in again after this upgrade. Tokens now require an issuer,
expiry, issued-at time, and a keyed credential binding. Every authenticated
request reloads account status and roles. A password update invalidates the
previous tokens, including updates made directly through SQL. The JWT does not
contain the stored password hash. `PIENG_JWT_SECRET` must have at least 32 bytes.

New and changed passwords use Argon2id (19 MiB, two passes, one lane). Existing
RFC2307 SSHA/SSHA256/SSHA512 hashes remain readable and migrate on successful
login using a compare-and-swap update. **An older PieNg application that cannot
read Argon2id must not share these password records after upgrading.** New
passwords must be 8-1024 bytes; legacy shorter passwords can still sign in and
upgrade. Self-service changes require `current_password`; administrator resets
of another account do not. Successful self-service changes require re-login.

## Allocation and auditing

Host addresses must be literal IPs within the selected leaf network. Updates
are scoped to both network ID and address. IPv4 network/broadcast addresses are
reserved except on /31 and /32. Subnet allocations must be canonical, contained,
strictly more specific than the parent, non-overlapping with siblings, and
permitted by `subdivide` and `valid_masks`. An empty or NULL `valid_masks` retains
the legacy meaning of no explicit mask restriction. Parent type changes cannot
hide existing hosts or child networks.

All API mutations take the PostgreSQL transaction-scoped advisory lock
`0x475049454e47` (decimal 78410152234567) and recheck authorization after acquiring
it. This intentionally serializes infrequent administrative writes across
multiple GoPieNg processes. Parent row locks protect structural operations;
state changes and audit insertion commit or roll back together. **Direct SQL
writers are not automatically protected by this application protocol.** They
must use the same advisory lock before reading allocation state, enforce the
same invariants, and record their changes, or run while application writers are
stopped. No overlap constraints are silently installed on legacy databases.

Audit events capture actor names inside the event, preserving attribution when
an account is deleted. User-management events use `0.0.0.0/0` as a documented
non-IP sentinel because the legacy changelog requires an inet prefix. Password
values/hashes are never put in those audit events. Read limits are 1-1000 events.
The last active administrator cannot be disabled, demoted or deleted; a signed-in
administrator cannot delete their own account.

Automatic allocation skips occupied intervals, including large IPv6 pools.
Exhaustive subnet listings remain capped at 65,536 candidates and return 422
when too large, rather than claiming the pool is empty. Use **Assign next** for
large pools. The frontend now supports /31, /32, /127 and /128 allocations and
numeric IPv6 ordering, invalidates child caches after allocation, and does not
consume change notifications while refreshes are deferred or fail.

## HTTP, probes and chroot

Forwarded client addresses are ignored unless the immediate peer is trusted.
Configure only actual reverse proxies, for example:

```sh
export PIENG_TRUSTED_PROXIES='127.0.0.1/32,::1/128'
```

The forwarding chain is evaluated from right to left. FastCGI's `REMOTE_ADDR`
should already be the actual client, as set by the trusted web server; do not
trust arbitrary Internet clients as proxies. Login requests have a separate
20-per-minute IP limit in addition to the general 300-per-minute limit. Bucket
storage and concurrent password hashes/probes are bounded. CORS is actually
disabled when `PIENG_CORS_ORIGINS` is unset; passing an empty list to chi/cors
would instead enable its wildcard default. API responses use `no-store`.

Active checks require an editor role and a literal, global-unicast address in
a managed leaf network. Private IPv4/IPv6 targets are allowed for WISP use;
loopback, link-local, unspecified and multicast targets are not. TCP probes use
context cancellation, correctly bracket IPv6, recognize ECONNREFUSED, and permit
at most eight concurrent probes. This is reachability evidence, not proof that
an address is unused: a firewall or other device can answer on its behalf.

Static assets are embedded by default so they survive chroot. `-webroot DIR`
loads an optional external tree into memory before privilege drop (32 MiB cap;
no symlinks). `-no-static` still permits a separate web server to serve assets.
An explicit webroot is a startup snapshot; restart to pick up changes. Rebuild
and redeploy the binary to update its embedded assets. Separately hosted assets
must be upgraded with the backend; the module graph is cache-busted as v10.

Chroot and supplementary-group-drop failures are now fatal, as are pledge
failures on OpenBSD. Ensure the jail exists before starting as root. For a
local PostgreSQL database, use the numeric host `127.0.0.1` in the DSN: preopening
one connection does not ensure future pool connections can resolve `localhost`
after chroot. Remote DNS, Unix database sockets, TLS root certificates and
client certificates must be available at their in-jail paths. The application
does not provision those files. Cross-compilation is not a live OpenBSD
privilege-drop/reconnection test. PID-file cleanup and graceful FastCGI shutdown
still need a separate daemon-lifecycle pass; prefer rc.d process matching over
relying on automatic removal of a root-owned PID file outside the jail.

## Tests

```sh
go test -race ./...
go vet ./...
node --experimental-default-type=module --test web/js/*.test.mjs
PIENG_TEST_DSN='postgres://postgres:postgres@127.0.0.1:5432/gopieng_test?sslmode=disable' go test -race -count=1 ./...
```

Without `PIENG_TEST_DSN`, the PostgreSQL integration tests explicitly skip.
Use a disposable test database with permission to create/drop schemas, never a
production DSN. Each test owns a separate schema and removes it on cleanup.
CI runs those tests against PostgreSQL 16 on Go 1.22.x and current stable Go,
including overlapping-prefix races, simultaneous host allocations, rollback
when audit insertion fails, authorization revocation, password resets, legacy
hash migration, and retained audit history. It also checks JavaScript syntax
and state helpers and cross-builds the OpenBSD/amd64 server. These are not
browser end-to-end tests or live OpenBSD deployment tests.
