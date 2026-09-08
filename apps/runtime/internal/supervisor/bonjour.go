// Bonjour advertisement — how a phone that has never been told an address finds this
// Mac (plan §3, Phase 2 item 2).
//
// The advertiser is an ADVISORY child: started once Caddy is answering, withdrawn first
// on the way down, and never fatal. A household whose registration failed still has a
// working server — every browser and every device typing the address in reaches it — so
// a failure here is a warning in the log and a line in `status`, never a refused start.
//
// What is advertised is the PUBLIC Caddy port, because it is the only port another
// device should reach: the api, PowerSync's own listener and Postgres are loopback
// concerns hidden behind it.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

const (
	// bonjourCensusTimeout bounds the household query. It is deliberately short: this
	// runs on a ticker beside a live server, and a hung psql must not still be holding
	// the goroutine when the next tick arrives.
	bonjourCensusTimeout = 5 * time.Second
	// bonjourSetupPoll is how often an install with no household re-asks whether one has
	// appeared. See startBonjour for why the polling stops the moment one has.
	bonjourSetupPoll = 60 * time.Second
)

// bonjourState is what the running supervisor records about its advertisement, so that
// `status` — a different process, polled every second by the menu-bar app — can report
// it without a database query or a `ps` of dns-sd's argv.
//
// SupervisorPID is the freshness check. A supervisor that was SIGKILLed leaves this file
// behind while mDNSResponder has already withdrawn the registration (it died with the
// dns-sd child), so every field is trusted only while that pid is alive.
type bonjourState struct {
	SupervisorPID int    `json:"supervisorPid"`
	Name          string `json:"name"`
	Port          int    `json:"port"`
	URL           string `json:"url"`
	Setup         bool   `json:"setup"`
	Error         string `json:"error"`
	UpdatedAt     string `json:"updatedAt"`
}

func writeBonjourState(path string, st bonjourState) error {
	st.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, append(raw, '\n'), 0o600)
}

func readBonjourState(path string) (bonjourState, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return bonjourState{}, false
	}
	var st bonjourState
	if err := json.Unmarshal(raw, &st); err != nil {
		return bonjourState{}, false
	}
	return st, true
}

// bonjourStatus renders the status block from the recorded state and whether the dns-sd
// child is actually running. Both have to be true for anything to be reported: the file
// says what was asked for, the process says whether it is still on the network.
func bonjourStatus(statePath string, childRunning bool) status.Bonjour {
	// The service type is constant and is reported even when nothing is advertising, so
	// a client always knows what to look for.
	b := status.Bonjour{Service: bonjour.ServiceType}
	st, ok := readBonjourState(statePath)
	if !ok || !processAlive(st.SupervisorPID) {
		return b
	}
	b.Name = st.Name
	b.Port = st.Port
	b.Error = st.Error
	if host, err := os.Hostname(); err == nil {
		b.Host = bonjour.Host(host)
	}
	b.Advertised = childRunning && st.Error == ""
	if !b.Advertised {
		// Nothing is on the network, so nothing is named on it.
		b.Name = ""
		b.Port = 0
	}
	return b
}

// BonjourStatus is the block `status` reports.
func (s *Supervisor) BonjourStatus() status.Bonjour {
	return bonjourStatus(s.plan.Layout.BonjourState, s.serviceRunning(services.Bonjour))
}

// startBonjour advertises the server, and is called once Caddy is healthy. It never
// returns an error: every failure is recorded and logged instead.
func (s *Supervisor) startBonjour(ctx context.Context) {
	if bonjour.Tool() == "" {
		s.recordBonjour(bonjourState{Error: "this platform has no dns-sd client, so the server is not discoverable"})
		s.log.Infof("skipping Bonjour: no dns-sd client on this platform")
		return
	}

	s.mu.Lock()
	s.bonjourStop = make(chan struct{})
	s.bonjourOnce = sync.Once{}
	stop := s.bonjourStop
	s.mu.Unlock()

	census := s.householdCensus(ctx)
	if !s.advertise(ctx, census) {
		return
	}

	// Re-checking is narrowed to the ONE transition that matters to a person: an install
	// with no household yet advertises `setup=1`, and the moment the wizard creates one
	// the name and the flag both change. Polling stops for good as soon as a household
	// exists, so a settled install pays nothing at all and this goroutine stops existing
	// minutes into the life of a fresh one.
	//
	// The limitation this leaves is deliberate and documented: renaming a household
	// later does not change what is advertised until the next restart.
	if _, setup := census.Advertise(""); !setup {
		return
	}
	s.bonjourWait.Add(1)
	go func() {
		defer s.bonjourWait.Done()
		ticker := time.NewTicker(bonjourSetupPoll)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			c := s.householdCensus(ctx)
			if !c.Known || c.Count == 0 {
				continue
			}
			// The query took time; a Stop may have arrived while it ran.
			select {
			case <-stop:
				return
			default:
			}
			s.log.Infof("a household now exists — re-advertising it on Bonjour")
			s.stopBonjourChild()
			s.advertise(ctx, c)
			return
		}
	}()
}

// advertise (re)registers the instance the census describes, and reports whether it is
// now on the network.
func (s *Supervisor) advertise(ctx context.Context, census bonjour.Census) bool {
	name, setup := census.Advertise(bonjour.ComputerName())
	inst := bonjour.Instance{
		Name:    name,
		Port:    s.plan.Ports.Public,
		URL:     s.advertisedURL(),
		Version: s.waffledVersion(),
		Setup:   setup,
	}
	st := bonjourState{Name: inst.Name, Port: inst.Port, URL: inst.URL, Setup: inst.Setup}

	if err := s.startChild(ctx, s.plan.Bonjour(inst), 0); err != nil {
		st.Error = err.Error()
		s.recordBonjour(st)
		// Warn, never fail: discovery is a convenience on top of a server that works.
		s.log.Warnf("could not advertise on Bonjour (the server is fine; devices will need the address): %v", err)
		return false
	}
	s.recordBonjour(st)
	s.log.Infof("advertising %q on %s port %d (setup=%v)", inst.Name, bonjour.ServiceType, inst.Port, setup)
	return true
}

func (s *Supervisor) recordBonjour(st bonjourState) {
	st.SupervisorPID = os.Getpid()
	if err := writeBonjourState(s.plan.Layout.BonjourState, st); err != nil {
		s.log.Warnf("could not record the Bonjour advertisement: %v", err)
	}
}

// stopBonjour withdraws the advertisement. Killing dns-sd is what deregisters the
// service — mDNSResponder drops a registration when the client that made it goes away —
// so this is the whole of "stop advertising".
//
// The refresh goroutine is stopped and waited for FIRST: it may be in the middle of
// deciding to restart the child, and a stop that raced it could leave a fresh dns-sd
// advertising a server that is shutting down.
func (s *Supervisor) stopBonjour() {
	s.mu.Lock()
	stop := s.bonjourStop
	once := &s.bonjourOnce
	s.mu.Unlock()
	if stop != nil {
		// Idempotent: RunForeground calls Stop on a failed start, and the integration
		// harness calls it again from t.Cleanup.
		once.Do(func() { close(stop) })
	}
	s.bonjourWait.Wait()

	s.stopBonjourChild()
	_ = os.Remove(s.plan.Layout.BonjourState)
}

func (s *Supervisor) stopBonjourChild() {
	s.mu.Lock()
	c := s.children[services.Bonjour]
	delete(s.children, services.Bonjour)
	s.mu.Unlock()
	if c != nil {
		if err := c.stop(stopGrace); err != nil {
			s.log.Warnf("%v", err)
		}
		return
	}
	if s.serviceRunning(services.Bonjour) {
		if err := s.stopOrphan(services.Bonjour); err != nil {
			s.log.Warnf("%v", err)
		}
	}
}

// advertisedURL is the address to put in the TXT record. The LAN address is the useful
// one; when this Mac has none, the multicast hostname is still resolvable by whoever
// found the advertisement in the first place.
func (s *Supervisor) advertisedURL() string {
	if lan := s.LANURL(); lan != "" {
		return lan
	}
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	if h := bonjour.Host(host); h != "" {
		return "http://" + h + ":" + strconv.Itoa(s.plan.Ports.Public)
	}
	return ""
}

func (s *Supervisor) waffledVersion() string {
	if s.manifest == nil {
		return ""
	}
	return s.manifest.WaffledVersion
}

// householdCensus asks the database how many households this install has. A failure is
// "unknown", never "none": `setup=1` tells a phone to go and finish setup on the Mac,
// and a busy psql is not a reason to send someone back to a wizard they completed.
func (s *Supervisor) householdCensus(ctx context.Context) bonjour.Census {
	ctx, cancel := context.WithTimeout(ctx, bonjourCensusTimeout)
	defer cancel()
	out, err := s.QueryScalar(ctx, s.plan.Env.PostgresDB(), householdCensusSQL)
	if err != nil {
		s.log.Warnf("could not read the household name for the Bonjour advertisement: %v", err)
		return bonjour.Census{}
	}
	return parseCensus(out)
}

// One scalar, not two queries: with exactly one row max(name) IS that row's name, and
// with any other count the name is not used at all.
const householdCensusSQL = `select count(*) || '|' || coalesce(max(name), '') from households where deleted_at is null`

func parseCensus(out string) bonjour.Census {
	// Cut once: a household name may contain the separator, the count never can.
	count, name, ok := strings.Cut(strings.TrimSpace(out), "|")
	if !ok {
		return bonjour.Census{}
	}
	n, err := strconv.Atoi(strings.TrimSpace(count))
	if err != nil || n < 0 {
		return bonjour.Census{}
	}
	return bonjour.Census{Known: true, Count: n, Name: name}
}
