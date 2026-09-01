package ipam

import (
	"errors"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
)

const maxEnumeratedSubnets = 65536

func ParseSmallIntArray(pg string) []int16 {
	pg = strings.Trim(pg, "{} ")
	if pg == "" {
		return nil
	}
	parts := strings.Split(pg, ",")
	var out []int16
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		v, _ := strconv.Atoi(p)
		out = append(out, int16(v))
	}
	return out
}

func FormatSmallIntArray(vals []int16) string {
	if len(vals) == 0 {
		return "{}"
	}
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = fmt.Sprintf("%d", v)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func InterfaceToSmallIntSlice(v any) []int16 {
	switch t := v.(type) {
	case []any:
		var out []int16
		for _, e := range t {
			switch u := e.(type) {
			case float64:
				out = append(out, int16(u))
			case int:
				out = append(out, int16(u))
			}
		}
		return out
	default:
		return nil
	}
}

func NextFreeHostStr(cidr string, used map[string]bool) string {
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return ""
	}
	return NextFreeHost(n, used)
}

func NextFreeHost(n *net.IPNet, used map[string]bool) string {
	if n == nil {
		return ""
	}
	first, last := firstAndLast(n)
	f := ipToBig(first)
	l := ipToBig(last)
	ipv6 := n.IP.To4() == nil
	diff := new(big.Int).Sub(l, f)
	if !ipv6 && diff.Cmp(big.NewInt(1)) > 0 {
		f = new(big.Int).Add(f, big.NewInt(1))
		l = new(big.Int).Sub(l, big.NewInt(1))
	}
	for cur := new(big.Int).Set(f); cur.Cmp(l) <= 0; cur.Add(cur, big.NewInt(1)) {
		ip := bigToIP(cur, ipv6).String()
		if !used[ip] {
			return ip
		}
	}
	return ""
}

func NextFreeSubnetStr(parent string, children []string, desiredMask int) (string, error) {
	p := cidrIPNet(parent)
	if p == nil {
		return "", errors.New("invalid parent network")
	}
	return NextFreeSubnet(p, children, desiredMask)
}

func NextFreeSubnet(parent *net.IPNet, childCIDRs []string, desiredMask int) (string, error) {
	if parent == nil {
		return "", errors.New("invalid parent network")
	}
	if desiredMask <= 0 {
		return "", errors.New("mask required")
	}
	pm, bits := parent.Mask.Size()
	if pm < 0 || bits == 0 || desiredMask > bits {
		return "", errors.New("invalid mask")
	}
	if desiredMask < pm {
		return "", fmt.Errorf("mask %d < parent %d", desiredMask, pm)
	}
	if !enumerationAllowed(pm, desiredMask) {
		return "", fmt.Errorf("requested split is too large to enumerate")
	}

	existing := []*net.IPNet{}
	for _, c := range childCIDRs {
		_, n, err := net.ParseCIDR(c)
		if err == nil {
			existing = append(existing, n)
		}
	}
	for _, n := range SplitInto(parent, desiredMask) {
		collides := false
		for _, c := range existing {
			if Overlap(n, c) {
				collides = true
				break
			}
		}
		if !collides {
			return n.String(), nil
		}
	}
	return "", errors.New("no space")
}

func enumerationAllowed(parentMask, newMask int) bool {
	if newMask < parentMask {
		return false
	}
	delta := newMask - parentMask
	// 2^16 == 65536. Avoid shifts large enough to overflow an int and avoid
	// allocating unbounded slices even on 64-bit systems.
	return delta <= 16 && (1<<delta) <= maxEnumeratedSubnets
}

func SplitInto(parent *net.IPNet, newMask int) []*net.IPNet {
	if parent == nil {
		return nil
	}
	pm, bits := parent.Mask.Size()
	if pm < 0 || bits == 0 || newMask < pm || newMask > bits {
		return nil
	}
	if newMask == pm {
		return []*net.IPNet{parent}
	}
	if !enumerationAllowed(pm, newMask) {
		return nil
	}

	n := 1 << (newMask - pm)
	first := ipToBig(parent.IP)
	size := new(big.Int).Lsh(big.NewInt(1), uint(bits-newMask))
	out := make([]*net.IPNet, 0, n)
	for i := 0; i < n; i++ {
		base := new(big.Int).Add(first, new(big.Int).Mul(size, big.NewInt(int64(i))))
		ip := bigToIP(base, bits == 128)
		_, cidr, err := net.ParseCIDR(fmt.Sprintf("%s/%d", ip.String(), newMask))
		if err == nil {
			out = append(out, cidr)
		}
	}
	return out
}

func Overlap(a, b *net.IPNet) bool {
	if a == nil || b == nil {
		return false
	}
	fa, la := firstAndLast(a)
	fb, lb := firstAndLast(b)
	a0, a1 := ipToBig(fa), ipToBig(la)
	b0, b1 := ipToBig(fb), ipToBig(lb)
	if a1.Cmp(b0) < 0 {
		return false
	}
	if b1.Cmp(a0) < 0 {
		return false
	}
	return true
}

func OverlapStr(a, b string) bool {
	_, na, err1 := net.ParseCIDR(a)
	_, nb, err2 := net.ParseCIDR(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return Overlap(na, nb)
}

func ContainsStr(parent, child string) bool {
	_, pn, err1 := net.ParseCIDR(parent)
	_, cn, err2 := net.ParseCIDR(child)
	if err1 != nil || err2 != nil {
		return false
	}
	fc, lc := firstAndLast(cn)
	return pn.Contains(fc) && pn.Contains(lc)
}

func firstAndLast(n *net.IPNet) (net.IP, net.IP) {
	if v4 := n.IP.To4(); v4 != nil {
		mask := n.Mask
		if len(mask) == 16 {
			mask = mask[12:]
		}
		first := make([]byte, 4)
		for i := 0; i < 4; i++ {
			first[i] = v4[i] & mask[i]
		}
		last := make([]byte, 4)
		for i := 0; i < 4; i++ {
			last[i] = first[i] | ^mask[i]
		}
		return net.IP(first), net.IP(last)
	}

	ip := n.IP.To16()
	mask := n.Mask
	if len(mask) == 4 {
		newMask := make([]byte, 16)
		copy(newMask[12:], mask)
		mask = newMask
	}
	first := make([]byte, 16)
	for i := 0; i < 16; i++ {
		first[i] = ip[i] & mask[i]
	}
	last := make([]byte, 16)
	for i := 0; i < 16; i++ {
		last[i] = first[i] | ^mask[i]
	}
	return net.IP(first), net.IP(last)
}

func ipToBig(ip net.IP) *big.Int {
	if v4 := ip.To4(); v4 != nil {
		return new(big.Int).SetBytes(v4)
	}
	ip = ip.To16()
	if ip == nil {
		return big.NewInt(0)
	}
	return new(big.Int).SetBytes(ip)
}

func bigToIP(x *big.Int, v6 bool) net.IP {
	b := x.Bytes()
	if v6 {
		ip := make([]byte, 16)
		if len(b) > 0 && len(b) <= 16 {
			copy(ip[16-len(b):], b)
		} else if len(b) > 16 {
			copy(ip, b[len(b)-16:])
		}
		return net.IP(ip)
	}
	ip := make([]byte, 4)
	if len(b) > 0 && len(b) <= 4 {
		copy(ip[4-len(b):], b)
	} else if len(b) > 4 {
		copy(ip, b[len(b)-4:])
	}
	return net.IP(ip)
}

func cidrIPNet(c string) *net.IPNet {
	_, n, err := net.ParseCIDR(c)
	if err != nil {
		return nil
	}
	return n
}

func GetMask(cidr string) int {
	parts := strings.Split(cidr, "/")
	if len(parts) != 2 {
		return 0
	}
	m, _ := strconv.Atoi(parts[1])
	return m
}

func AllHostsStr(cidr string) []string {
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil
	}

	first, last := firstAndLast(n)
	f := ipToBig(first)
	l := ipToBig(last)
	ipv6 := n.IP.To4() == nil

	diff := new(big.Int).Sub(l, f)
	if !ipv6 && diff.Cmp(big.NewInt(1)) > 0 {
		f = new(big.Int).Add(f, big.NewInt(1))
		l = new(big.Int).Sub(l, big.NewInt(1))
	}

	count := new(big.Int).Sub(l, f)
	count.Add(count, big.NewInt(1))
	if count.Cmp(big.NewInt(4096)) > 0 {
		return nil
	}

	var out []string
	for cur := new(big.Int).Set(f); cur.Cmp(l) <= 0; cur.Add(cur, big.NewInt(1)) {
		out = append(out, bigToIP(cur, ipv6).String())
	}
	return out
}

func AvailableSubnetsStr(parent string, children []string, mask int) []string {
	p := cidrIPNet(parent)
	if p == nil {
		return nil
	}
	pm, bits := p.Mask.Size()
	if pm < 0 || bits == 0 || mask < pm || mask > bits || !enumerationAllowed(pm, mask) {
		return nil
	}

	existing := []*net.IPNet{}
	for _, c := range children {
		_, n, err := net.ParseCIDR(c)
		if err == nil {
			existing = append(existing, n)
		}
	}

	var out []string
	for _, sub := range SplitInto(p, mask) {
		collides := false
		for _, c := range existing {
			if Overlap(sub, c) {
				collides = true
				break
			}
		}
		if !collides {
			out = append(out, sub.String())
		}
	}
	return out
}
