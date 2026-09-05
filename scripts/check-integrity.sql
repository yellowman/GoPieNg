-- Read-only preflight for legacy data; does not repair or delete anything.
BEGIN READ ONLY;
-- Child range must be inside a subdividable parent and strictly more specific.
SELECT c.id, c.address_range, p.address_range AS parent_range, p.subdivide
FROM networks c JOIN networks p ON c.parent=p.id
WHERE NOT p.subdivide OR NOT (c.address_range << p.address_range);
-- Sibling allocations must not overlap.
SELECT a.id, a.address_range, b.id, b.address_range
FROM networks a JOIN networks b ON a.parent=b.parent AND a.id<b.id
WHERE a.address_range && b.address_range;
-- Host addresses must belong to leaf networks and carry full host masks.
SELECT h.address, h.network, n.address_range, n.subdivide
FROM hosts h JOIN networks n ON h.network=n.id
WHERE n.subdivide OR NOT (h.address <<= n.address_range)
   OR masklen(h.address) <> CASE family(h.address) WHEN 4 THEN 32 ELSE 128 END;
COMMIT;
