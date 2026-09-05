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

func TestNextFreeSubnetLargeSpaceDoesNotEnumerate(t *testing.T) {
	for _, tc := range []struct {
		parent string
		mask   int
		want   string
	}{
		{"10.0.0.0/8", 32, "10.0.0.0/32"},
		{"2001:db8::/32", 64, "2001:db8::/64"},
		{"2001:db8::/32", 128, "2001:db8::/128"},
	} {
		got, err := NextFreeSubnetStr(tc.parent, nil, tc.mask)
		if err != nil || got != tc.want {
			t.Fatalf("%s -> /%d: %q, %v", tc.parent, tc.mask, got, err)
		}
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

func TestNextFreeSubnetSkipsOccupiedIntervals(t *testing.T) {
	for _, tc := range []struct {
		parent   string
		children []string
		mask     int
		want     string
	}{
		{"10.0.0.0/24", []string{"10.0.0.0/26", "10.0.0.64/27"}, 27, "10.0.0.96/27"},
		{"10.0.0.0/24", []string{"10.0.0.0/28"}, 26, "10.0.0.64/26"},
		{"10.0.0.0/24", []string{"10.0.0.0/25", "10.0.0.16/28"}, 26, "10.0.0.128/26"},
		{"2001:db8::/32", []string{"2001:db8::/33"}, 64, "2001:db8:8000::/64"},
		{"2001:db8::/32", []string{"2001:db8::/32"}, 64, ""},
		{"10.0.0.0/24", []string{"::/0"}, 28, "10.0.0.0/28"},
	} {
		got, err := NextFreeSubnetStr(tc.parent, tc.children, tc.mask)
		if got != tc.want || (err != nil) != (tc.want == "") {
			t.Fatalf("%s %v: got %q err %v, want %q", tc.parent, tc.children, got, err, tc.want)
		}
	}
}

func TestMixedFamilyOverlap(t *testing.T) {
	if OverlapStr("10.0.0.0/8", "::/0") {
		t.Fatal("IPv4 and IPv6 cannot overlap")
	}
	if ContainsStr("::/0", "10.0.0.0/8") {
		t.Fatal("IPv6 cannot contain IPv4")
	}
}

func TestSmallHostRanges(t *testing.T) {
	for _, tc := range []struct {
		cidr  string
		n     int
		first string
	}{{"192.0.2.0/31", 2, "192.0.2.0"}, {"192.0.2.1/32", 1, "192.0.2.1"}, {"192.0.2.0/30", 2, "192.0.2.1"}, {"2001:db8::/126", 4, "2001:db8::"}} {
		got := AllHostsStr(tc.cidr)
		if len(got) != tc.n || got[0] != tc.first {
			t.Fatalf("%s: %v", tc.cidr, got)
		}
		used := map[string]bool{}
		for _, host := range got {
			if next := NextFreeHostStr(tc.cidr, used); next != host {
				t.Fatalf("want %s got %s", host, next)
			}
			used[host] = true
		}
		if next := NextFreeHostStr(tc.cidr, used); next != "" {
			t.Fatal("full subnet returned host", next)
		}
	}
}

func TestAvailableMatchesBruteForce(t *testing.T) {
	_, parent, _ := net.ParseCIDR("10.0.0.0/24")
	for n := 0; n < 16; n++ {
		child := SplitInto(parent, 28)[n].String()
		children := []string{child, "10.0.0.0/26", "10.0.0.32/27"}
		actual := AvailableSubnetsStr(parent.String(), children, 28)
		want := []string{}
		for _, candidate := range SplitInto(parent, 28) {
			collision := false
			for _, allocated := range children {
				if OverlapStr(candidate.String(), allocated) {
					collision = true
				}
			}
			if !collision {
				want = append(want, candidate.String())
			}
		}
		if len(actual) != len(want) {
			t.Fatalf("availability count %d vs %d", len(actual), len(want))
		}
		for i := range want {
			if actual[i] != want[i] {
				t.Fatalf("%v vs %v", actual, want)
			}
		}
	}
}
