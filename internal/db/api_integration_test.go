package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/middleware"
)

var schemaSequence atomic.Int64

type fixture struct {
	db                             *sql.DB
	jwt                            *auth.Manager
	router                         http.Handler
	admin, editor, reader, creator string
}

// Tests create and drop only their own uniquely named schema. CI supplies a
// disposable PostgreSQL service; local tests skip unless PIENG_TEST_DSN is set.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	dsn := os.Getenv("PIENG_TEST_DSN")
	if dsn == "" {
		t.Skip("set PIENG_TEST_DSN to run PostgreSQL integration tests")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("gopieng_test_%d_%d", time.Now().UnixNano(), schemaSequence.Add(1))
	if _, err := admin.Exec(`CREATE SCHEMA ` + pq.QuoteIdentifier(schema)); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(`DROP SCHEMA ` + pq.QuoteIdentifier(schema) + ` CASCADE`); admin.Close() })
	scoped := dsn + " search_path=" + schema
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		scoped = u.String()
	}
	database, err := sql.Open("postgres", scoped)
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(8)
	t.Cleanup(func() { database.Close() })
	schemaSQL, err := os.ReadFile("../../schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(string(schemaSQL)); err != nil {
		t.Fatal(err)
	}
	f := &fixture{db: database, jwt: auth.NewManager([]byte(strings.Repeat("s", 32)))}
	targets := []*string{&f.admin, &f.editor, &f.reader, &f.creator}
	for i, role := range []string{"administrator", "editor", "reader", "creator"} {
		hash := auth.MakeRFC2307SSHA("test-password")
		if _, err := database.Exec(`INSERT INTO users(id,username,password,status) VALUES($1,$2,$3,1)`, i+1, role, hash); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Exec(`INSERT INTO user_roles("user",role) SELECT $1,id FROM roles WHERE name=$2`, i+1, role); err != nil {
			t.Fatal(err)
		}
		*targets[i], err = f.jwt.Sign(int64(i+1), []string{role}, hash)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.Exec(`SELECT setval(pg_get_serial_sequence('users','id'),4); INSERT INTO networks(id,address_range,subdivide,description) VALUES(1,'10.0.0.0/16',true,'root'); INSERT INTO networks(id,parent,address_range,subdivide,description) VALUES(2,1,'10.0.0.0/24',false,'leaf'),(3,1,'10.0.1.0/24',false,'leaf'); SELECT setval(pg_get_serial_sequence('networks','id'),3)`); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Post("/auth/login", auth.MakeLoginHandler(database, f.jwt))
	r.Group(func(r chi.Router) {
		r.Use(middleware.JWT(f.jwt, database))
		r.Get("/me", auth.MeHandler(database, f.jwt))
		r.Mount("/", API(database, f.jwt))
	})
	f.router = r
	return f
}

func request(h http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func (f *fixture) do(t *testing.T, method, path, token, body string, want int) *httptest.ResponseRecorder {
	t.Helper()
	w := request(f.router, method, path, token, body)
	if w.Code != want {
		t.Fatalf("%s %s: status %d, want %d; %s", method, path, w.Code, want, w.Body.String())
	}
	return w
}
func (f *fixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func (f *fixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.db.Exec(q, args...); err != nil {
		t.Fatal(err)
	}
}

func TestAPIHostBoundaries(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		path, body string
		status     int
	}{
		{"/networks/2/hosts", `{"address":"10.0.1.4","description":"outside"}`, 400},
		{"/networks/2/hosts", `{"address":"2001:db8::1"}`, 400},
		{"/networks/2/hosts", `{"address":"10.0.0.4/24"}`, 400},
		{"/networks/2/hosts", `{"address":"localhost"}`, 400},
		{"/networks/2/hosts", `{"address":"10.0.0.0"}`, 400},
		{"/networks/2/hosts", `{"address":"10.0.0.255"}`, 400},
		{"/networks/1/hosts", `{"address":"10.0.0.4"}`, 409},
		{"/networks/0/hosts", `{"address":"10.0.0.4"}`, 400},
		{"/networks/999/hosts", `{"address":"10.0.0.4"}`, 404},
		{"/networks/2/hosts", `{"address":"10.0.0.4","update":true}`, 404},
	} {
		f.do(t, "POST", tc.path, f.editor, tc.body, tc.status)
	}
	f.do(t, "POST", "/networks/2/hosts", f.editor, `{"address":"10.0.0.4","description":"valid"}`, 200)
	f.do(t, "POST", "/networks/3/hosts", f.editor, `{"address":"10.0.0.4","description":"wrong network","update":true}`, 400)
	if f.count(t, `SELECT COUNT(*) FROM hosts WHERE description='valid'`) != 1 {
		t.Fatal("wrong-network update changed host")
	}
	f.do(t, "POST", "/networks/2/hosts", f.reader, `{"address":"10.0.0.5"}`, 403)
	f.do(t, "PATCH", "/networks/2", f.admin, `{"subdivide":true}`, 409)
	f.do(t, "PATCH", "/networks/1", f.admin, `{"subdivide":false}`, 409)
	f.do(t, "DELETE", "/hosts/10.0.0.9", f.editor, "", 404)
}

func TestAPIPointToPointAndIPv6(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `INSERT INTO networks(id,address_range,subdivide) VALUES(20,'192.0.2.0/31',false),(21,'192.0.2.2/32',false),(22,'2001:db8::/126',false),(23,'2001:db9::/32',true)`)
	for _, tc := range []struct {
		id      int
		address string
	}{{20, "192.0.2.0"}, {20, "192.0.2.1"}, {21, "192.0.2.2"}, {22, "2001:db8::1"}} {
		f.do(t, "POST", fmt.Sprintf("/networks/%d/hosts", tc.id), f.editor, fmt.Sprintf(`{"address":%q}`, tc.address), 200)
	}
	if f.count(t, `SELECT COUNT(*) FROM changelog WHERE prefix='2001:db8::1/128'::inet`) != 1 {
		t.Fatal("IPv6 audit prefix must be /128")
	}
	f.do(t, "POST", "/networks/23/allocate-subnet", f.creator, `{"mask":64}`, 200)
	f.do(t, "GET", "/networks/23/available-subnets?mask=64", f.creator, "", 422)
}

func TestAPIAllocationPolicy(t *testing.T) {
	f := newFixture(t)
	f.do(t, "PATCH", "/networks/1", f.admin, `{"valid_masks":[24]}`, 200)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"mask":25}`, 400)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"cidr":"10.0.8.0/25"}`, 400)
	f.do(t, "POST", "/networks/2/allocate-subnet", f.creator, `{"mask":25}`, 409)
	f.do(t, "POST", "/networks/1/allocate-host", f.editor, `{}`, 409)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"cidr":"10.1.8.0/24"}`, 400)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"cidr":"10.0.8.1/24"}`, 400)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"cidr":"10.0.8.0/24","mask":25}`, 400)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"cidr":"10.0.0.0/24"}`, 409)
	f.do(t, "PATCH", "/networks/1", f.editor, `{"valid_masks":[25]}`, 403)
	f.do(t, "PATCH", "/networks/1", f.admin, `{"valid_masks":[16]}`, 400)
	f.do(t, "PATCH", "/networks/1", f.admin, `{"valid_masks":[33]}`, 400)
	f.do(t, "PATCH", "/networks/1", f.admin, `{"valid_masks":[24,24]}`, 400)
	f.do(t, "POST", "/networks/1/allocate-subnet", f.creator, `{"mask":24}`, 200)
}

func TestAPIConcurrentOverlappingSubnets(t *testing.T) {
	f := newFixture(t)
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 2)
	for _, cidr := range []string{"10.0.8.0/25", "10.0.8.0/26"} {
		go func(cidr string) {
			<-start
			results <- request(f.router, "POST", "/networks/1/allocate-subnet", f.creator, fmt.Sprintf(`{"cidr":%q}`, cidr))
		}(cidr)
	}
	close(start)
	codes := map[int]int{}
	for i := 0; i < 2; i++ {
		w := <-results
		codes[w.Code]++
		if w.Code != 200 && w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if codes[200] != 1 || codes[409] != 1 {
		t.Fatalf("overlap race: %v", codes)
	}
	if f.count(t, `SELECT COUNT(*) FROM networks a JOIN networks b ON a.parent=b.parent AND a.id<b.id AND a.address_range && b.address_range`) != 0 {
		t.Fatal("overlapping sibling allocations committed")
	}
}

func TestAPIConcurrentHostAllocations(t *testing.T) {
	f := newFixture(t)
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 16)
	for i := 0; i < 16; i++ {
		go func() { <-start; results <- request(f.router, "POST", "/networks/2/allocate-host", f.editor, `{}`) }()
	}
	close(start)
	for i := 0; i < 16; i++ {
		w := <-results
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if f.count(t, `SELECT COUNT(*) FROM hosts`) != 16 || f.count(t, `SELECT COUNT(*) FROM changelog`) != 16 {
		t.Fatal("lost allocation or audit event")
	}
}

func TestAPIAuditFailureRollsBackMutation(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON changelog FOR EACH ROW EXECUTE FUNCTION reject_audit()`)
	f.do(t, "POST", "/networks/2/allocate-host", f.editor, `{}`, 500)
	f.do(t, "PATCH", "/users/2", f.admin, `{"roles":["reader"]}`, 500)
	if f.count(t, `SELECT COUNT(*) FROM hosts`) != 0 {
		t.Fatal("allocation survived failed audit")
	}
	if f.count(t, `SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id=ur.role WHERE ur."user"=2 AND r.name='editor'`) != 1 {
		t.Fatal("role update survived failed audit")
	}
}

func TestAPIUserTransactionsAndRevocation(t *testing.T) {
	f := newFixture(t)
	f.do(t, "POST", "/users", f.admin, `{"username":"new","password":"safe-password","roles":["not-a-role"]}`, 400)
	if f.count(t, `SELECT COUNT(*) FROM users WHERE username='new'`) != 0 {
		t.Fatal("partially created user")
	}
	f.do(t, "PATCH", "/users/2", f.admin, `{"roles":["reader","not-a-role"]}`, 400)
	f.do(t, "POST", "/networks/2/allocate-host", f.editor, `{}`, 200)
	f.do(t, "PATCH", "/users/2", f.admin, `{"roles":["reader"]}`, 200)
	f.do(t, "POST", "/networks/2/allocate-host", f.editor, `{}`, 403)
	f.do(t, "PATCH", "/users/2", f.admin, `{"status":0}`, 200)
	f.do(t, "GET", "/networks", f.editor, "", 401)
	f.do(t, "PATCH", "/users/1", f.admin, `{"status":0}`, 409)
	f.do(t, "PATCH", "/users/1", f.admin, `{"roles":[]}`, 409)
	f.do(t, "DELETE", "/users/1", f.admin, "", 409)
	f.do(t, "PATCH", "/users/999", f.admin, `{"roles":[]}`, 404)
}

func TestAPIPasswordChangeRequiresCurrentAndRevokes(t *testing.T) {
	f := newFixture(t)
	f.do(t, "PATCH", "/users/2", f.editor, `{"password":"new-password"}`, 403)
	f.do(t, "PATCH", "/users/2", f.editor, `{"password":"new-password","current_password":"wrong"}`, 403)
	f.do(t, "PATCH", "/users/2", f.editor, `{"password":"new-password","current_password":"test-password"}`, 200)
	f.do(t, "GET", "/networks", f.editor, "", 401)
	var stored string
	if err := f.db.QueryRow(`SELECT password FROM users WHERE id=2`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "$argon2id$") {
		t.Fatal("password was not upgraded")
	}
	f.do(t, "POST", "/auth/login", "", `{"username":"editor","password":"test-password"}`, 401)
	w := f.do(t, "POST", "/auth/login", "", `{"username":"editor","password":"new-password"}`, 200)
	var login struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil {
		t.Fatal(err)
	}
	f.do(t, "GET", "/networks", login.Token, "", 200)
	f.do(t, "PATCH", "/users/2", f.admin, `{"password":"admin-reset-password"}`, 200)
	f.do(t, "GET", "/networks", login.Token, "", 401)
	if f.count(t, `SELECT COUNT(*) FROM changelog WHERE change LIKE '%new-password%' OR change LIKE '%test-password%' OR change LIKE '%admin-reset-password%'`) != 0 {
		t.Fatal("password leaked into audit")
	}
}

func TestAPILegacyLoginUpgrade(t *testing.T) {
	f := newFixture(t)
	w := f.do(t, "POST", "/auth/login", "", `{"username":"editor","password":"test-password"}`, 200)
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	f.do(t, "GET", "/me", body.Token, "", 200)
	f.do(t, "GET", "/me", f.editor, "", 401)
	if f.count(t, `SELECT COUNT(*) FROM users WHERE id=2 AND password LIKE '$argon2id$%'`) != 1 {
		t.Fatal("legacy hash not upgraded")
	}
}

func TestAPIDeletedUserAuditRemainsVisible(t *testing.T) {
	f := newFixture(t)
	f.do(t, "POST", "/networks/2/hosts", f.editor, `{"address":"10.0.0.10","description":"audit-marker"}`, 200)
	f.do(t, "DELETE", "/users/2", f.admin, "", 200)
	f.do(t, "GET", "/networks", f.editor, "", 401)
	w := f.do(t, "GET", "/logs", f.reader, "", 200)
	if !strings.Contains(w.Body.String(), "audit-marker") || !strings.Contains(w.Body.String(), `"user":"editor"`) {
		t.Fatal("deleted user's event or attribution vanished:", w.Body.String())
	}
	// A legacy NOT NULL changelog user must fail atomically, not strip roles.
	f.exec(t, `DELETE FROM changelog WHERE "user" IS NULL; ALTER TABLE changelog ALTER COLUMN "user" SET NOT NULL`)
	f.do(t, "POST", "/networks/2/hosts", f.creator, `{"address":"10.0.0.11"}`, 200)
	f.do(t, "DELETE", "/users/4", f.admin, "", 500)
	f.do(t, "POST", "/networks/2/allocate-host", f.creator, `{}`, 200)
}

func TestAPIMalformedRequests(t *testing.T) {
	f := newFixture(t)
	for _, body := range []string{"", `null`, `[]`, `{`, `{} {}`, `{"description":1}`, `{"unknown":true}`} {
		f.do(t, "POST", "/networks/2/allocate-host", f.editor, body, 400)
	}
	f.do(t, "POST", "/networks/2/allocate-host", f.editor, `{"description":"`+strings.Repeat("x", 65536)+`"}`, 413)
	f.do(t, "GET", "/logs?limit=-1", f.reader, "", 400)
	f.do(t, "GET", "/logs?limit=1001", f.reader, "", 400)
	f.do(t, "GET", "/networks?parent_id=abc", f.reader, "", 400)
}

func TestAPISearchWithSingleConnection(t *testing.T) {
	f := newFixture(t)
	f.db.SetMaxOpenConns(1)
	f.do(t, "POST", "/networks/2/hosts", f.editor, `{"address":"10.0.0.10","description":"find-me"}`, 200)
	w := f.do(t, "GET", "/search?q=find-me", f.reader, "", 200)
	if !strings.Contains(w.Body.String(), `"ancestry":[1,2]`) {
		t.Fatal(w.Body.String())
	}
	w = f.do(t, "GET", "/networks?q=leaf", f.reader, "", 200)
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal("root query leaked children", w.Body.String())
	}
	f.exec(t, `DROP TABLE hosts`)
	f.do(t, "GET", "/search?q=find-me", f.reader, "", 500)
}

func TestAPIProbeValidationAndIPv6(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `INSERT INTO networks(address_range,subdivide) VALUES('2001:db8::/64',false)`)
	var calls []string
	var mu sync.Mutex
	p := newIPProbe(f.db)
	p.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		mu.Lock()
		calls = append(calls, address)
		mu.Unlock()
		return nil, &net.OpError{Op: "dial", Net: network, Err: syscall.ECONNREFUSED}
	}
	r := chi.NewRouter()
	r.Use(middleware.JWT(f.jwt, f.db))
	r.Get("/check-ip/{ip}", p.serveHTTP)
	for _, tc := range []struct {
		ip   string
		want int
	}{{"localhost", 400}, {"127.0.0.1", 400}, {"169.254.169.254", 400}, {"::1", 400}, {"224.0.0.1", 400}, {"8.8.8.8", 403}} {
		w := request(r, "GET", "/check-ip/"+tc.ip, f.editor, "")
		if w.Code != tc.want {
			t.Fatal(tc.ip, w.Code, w.Body.String())
		}
	}
	if len(calls) != 0 {
		t.Fatal("invalid/unmanaged probe dialed:", calls)
	}
	for _, ip := range []string{"10.0.0.10", "2001:db8::1"} {
		w := request(r, "GET", "/check-ip/"+ip, f.editor, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"responds":true`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if len(calls) != 2 || calls[1] != "[2001:db8::1]:22" {
		t.Fatal("bad IPv6 dial:", calls)
	}
	w := request(r, "GET", "/check-ip/10.0.0.10", f.reader, "")
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
