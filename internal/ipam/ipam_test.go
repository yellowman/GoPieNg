package ipam

import (
	"net"
	"testing"
)

func TestSplitIntoBoundsEnumeration(t *testing.T) {
	_, parent, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	if got := SplitInto(parent, 24); len(got) != 65536 {
		t.Fatalf("/8 -> /24: got %d subnets, want 65536", len(got))
	}
	if got := SplitInto(parent, 25); got != nil {
		t.Fatalf("/8 -> /25 should be rejected, got %d subnets", len(got))
	}
}

func TestNextFreeSubnetRejectsPathologicalSplit(t *testing.T) {
	_, err := NextFreeSubnetStr("10.0.0.0/8", nil, 32)
	if err == nil {
		t.Fatal("expected oversized enumeration to be rejected")
	}
}

func TestAvailableSubnetsRejectsInvalidMask(t *testing.T) {
	if got := AvailableSubnetsStr("10.0.0.0/24", nil, 23); got != nil {
		t.Fatalf("mask broader than parent should be rejected: %#v", got)
	}
	if got := AvailableSubnetsStr("10.0.0.0/24", nil, 33); got != nil {
		t.Fatalf("invalid IPv4 mask should be rejected: %#v", got)
	}
}

func TestNextFreeHostBadCIDR(t *testing.T) {
	if got := NextFreeHostStr("not-a-network", nil); got != "" {
		t.Fatalf("bad CIDR returned %q", got)
	}
}
