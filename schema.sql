-- pieng database schema
-- PostgreSQL 12+

-- Networks table: hierarchical IP address blocks
CREATE TABLE IF NOT EXISTS networks (
    id SERIAL PRIMARY KEY,
    parent INTEGER REFERENCES networks(id),
    address_range CIDR NOT NULL,
    description TEXT,
    subdivide BOOLEAN NOT NULL,
    valid_masks SMALLINT[],
    owner VARCHAR(255),
    account VARCHAR(32),
    service INTEGER,
    CONSTRAINT networks_address_range_key UNIQUE (address_range)
);

-- Index for fast parent lookups
CREATE INDEX IF NOT EXISTS idx_networks_parent ON networks(parent);

-- Index for CIDR containment queries
CREATE INDEX IF NOT EXISTS idx_networks_address ON networks USING GIST (address_range inet_ops);

-- Hosts table: individual IP addresses
CREATE TABLE IF NOT EXISTS hosts (
    address INET PRIMARY KEY,
    network INTEGER NOT NULL REFERENCES networks(id),
    description TEXT NOT NULL
);

-- Index for fast network lookups
CREATE INDEX IF NOT EXISTS idx_hosts_network ON hosts(network);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(32) UNIQUE NOT NULL,
    password TEXT NOT NULL,          -- RFC 2307 format: {SSHA256}base64(hash+salt)
    email TEXT,
    status INTEGER NOT NULL DEFAULT 1         -- 1=active, 0=disabled
);

-- Roles table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL
);

-- User-role mapping
CREATE TABLE IF NOT EXISTS user_roles (
    "user" INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY ("user", role)
);

-- Audit log
-- Matches original PieNg schema with "user" FK to users table
CREATE TABLE IF NOT EXISTS changelog (
    id SERIAL PRIMARY KEY,
    "user" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    change_time TIMESTAMP NOT NULL DEFAULT NOW(),
    prefix INET NOT NULL,
    change TEXT NOT NULL
);

-- Index for recent changes
CREATE INDEX IF NOT EXISTS idx_changelog_time ON changelog(change_time DESC);

-- Default roles (matching original PieNg)
INSERT INTO roles (name) VALUES ('administrator') ON CONFLICT DO NOTHING;
INSERT INTO roles (name) VALUES ('creator') ON CONFLICT DO NOTHING;
INSERT INTO roles (name) VALUES ('editor') ON CONFLICT DO NOTHING;
INSERT INTO roles (name) VALUES ('reader') ON CONFLICT DO NOTHING;

-- ============================================
-- Migration: for new databases without users
-- ============================================

-- Grant administrator role to existing admin user (adjust username as needed)
-- INSERT INTO user_roles ("user", role)
-- SELECT u.id, r.id FROM users u, roles r 
-- WHERE u.username = 'admin' AND r.name = 'administrator'
-- ON CONFLICT DO NOTHING;

-- ============================================
-- Migration notes for existing databases
-- ============================================

-- If upgrading from an older schema, run this to allow user deletion:
-- ALTER TABLE changelog ALTER COLUMN "user" DROP NOT NULL;
-- ALTER TABLE changelog DROP CONSTRAINT IF EXISTS changelog_user_fkey;
-- ALTER TABLE changelog ADD CONSTRAINT changelog_user_fkey 
--     FOREIGN KEY ("user") REFERENCES users(id) ON DELETE SET NULL;

-- ============================================
-- Useful queries
-- ============================================

-- Find all children of a network
-- SELECT * FROM networks WHERE parent = <id> ORDER BY address_range;

-- Find network containing an IP
-- SELECT * FROM networks WHERE address_range >> '10.0.1.5'::inet;

-- Usage summary by owner
-- SELECT owner, COUNT(*), SUM(masklen(address_range)) 
-- FROM networks GROUP BY owner ORDER BY COUNT(*) DESC;

-- Recent activity by user
-- SELECT u.username, COUNT(*) 
-- FROM changelog c
-- JOIN users u ON c."user" = u.id
-- WHERE c.change_time > NOW() - INTERVAL '7 days'
-- GROUP BY u.username ORDER BY COUNT(*) DESC;
