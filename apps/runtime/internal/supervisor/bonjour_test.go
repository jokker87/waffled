package supervisor

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
)

func TestParseCensusReadsWhatPsqlPrints(t *testing.T) {
	cases := []struct {
		out  string
		want bonjour.Census
	}{
		// count|name, unaligned and untitled — what `psql -tAc` gives back.
		{"1|The Seinfelds\n", bonjour.Census{Known: true, Count: 1, Name: "The Seinfelds"}},
		{"0|\n", bonjour.Census{Known: true, Count: 0}},
		{"3|Costanza\n", bonjour.Census{Known: true, Count: 3, Name: "Costanza"}},
		// A household name may contain the separator; only the first one counts.
		{"1|Jerry|Elaine", bonjour.Census{Known: true, Count: 1, Name: "Jerry|Elaine"}},
		// Anything we cannot read is "unknown", never "no households".
		{"", bonjour.Census{}},
		{"psql: error: connection refused", bonjour.Census{}},
		{"|nonsense", bonjour.Census{}},
	}
	for _, tc := range cases {
		got := parseCensus(tc.out)
		if got != tc.want {
			t.Errorf("parseCensus(%q) = %+v, want %+v", tc.out, got, tc.want)
		}
	}
}

func TestBonjourStateRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if _, ok := readBonjourState(path); ok {
		t.Fatal("read a state file that does not exist")
	}

	want := bonjourState{
		SupervisorPID: os.Getpid(), Name: "Kevin’s Home", Port: 8080,
		URL: "http://192.168.1.5:8080", Setup: false, Error: "",
	}
	if err := writeBonjourState(path, want); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, ok := readBonjourState(path)
	if !ok {
		t.Fatal("the state file just written does not read back")
	}
	if got.Name != want.Name || got.Port != want.Port || got.URL != want.URL || got.SupervisorPID != want.SupervisorPID {
		t.Errorf("round trip lost something: %+v", got)
	}
	if got.UpdatedAt == "" {
		t.Error("UpdatedAt is empty — a stale file must be recognisable as old")
	}
	// It sits beside config.env in a directory that is 0700, but the file itself says
	// nothing secret; 0600 is the house style for everything the runtime writes.
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 600", perm)
	}
}

func TestBonjourStateFromADeadSupervisorIsNotReported(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bonjour.json")
	// A supervisor that was SIGKILLed leaves its file behind. Nothing is advertising —
	// mDNSResponder withdrew the registration when dns-sd died with it — so `status`
	// must not name a household that is not on the network.
	if err := writeBonjourState(path, bonjourState{
		SupervisorPID: 0x7FFFFFFE, Name: "The Seinfelds", Port: 8080, Error: "boom",
	}); err != nil {
		t.Fatal(err)
	}
	got := bonjourStatus(path, false)
	if got.Advertised || got.Name != "" || got.Port != 0 || got.Error != "" {
		t.Errorf("a stale file was reported as live: %+v", got)
	}
	if got.Service != bonjour.ServiceType {
		t.Errorf("service = %q, want the constant %q even when nothing is advertising", got.Service, bonjour.ServiceType)
	}
}

func TestBonjourStatusReportsTheLiveAdvertisement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if err := writeBonjourState(path, bonjourState{
		SupervisorPID: os.Getpid(), Name: "The Seinfelds", Port: 8080,
		URL: "http://192.168.1.5:8080",
	}); err != nil {
		t.Fatal(err)
	}

	got := bonjourStatus(path, true)
	if !got.Advertised {
		t.Error("advertised = false while the supervisor is alive and dns-sd is running")
	}
	if got.Name != "The Seinfelds" || got.Port != 8080 {
		t.Errorf("got %+v, want the recorded name and port", got)
	}
	if got.Host == "" {
		t.Error("host is empty — a device needs a name to resolve")
	}

	// dns-sd gone while the supervisor lives: the name is still what we asked for, but
	// nothing is on the network.
	if stopped := bonjourStatus(path, false); stopped.Advertised {
		t.Error("advertised = true with no dns-sd process")
	}
}

func TestBonjourStatusCarriesTheFailureReason(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if err := writeBonjourState(path, bonjourState{
		SupervisorPID: os.Getpid(), Error: "dns-sd is not available on this platform",
	}); err != nil {
		t.Fatal(err)
	}
	got := bonjourStatus(path, false)
	if got.Advertised {
		t.Error("advertised = true after a failure")
	}
	if got.Error == "" {
		t.Error("the failure reason was dropped — `status` is where someone looks for it")
	}
}
