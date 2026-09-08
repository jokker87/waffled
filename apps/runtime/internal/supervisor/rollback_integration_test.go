//go:build integration

// The pre-migration snapshot and its automatic rollback, against the real bundle.
//
// This test lives INSIDE package supervisor, unlike the rest of the integration suite,
// for one reason: forcing the post-migrate health gate to fail has to be done without
// shipping a way to do it. Supervisor.waitHealthy is an unexported field, always waitHTTP
// in production, and only a test in this package can swap it — so every line of the start
// sequence runs exactly as it does on a real Mac, and there is no environment variable or
// flag a household could trip into a fake failure.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration ./internal/supervisor/
package supervisor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
)

func integrationSupervisor(t *testing.T) (*Supervisor, string) {
	t.Helper()
	bundle := os.Getenv("WAFFLED_BUNDLE")
	if bundle == "" {
		t.Skip("set WAFFLED_BUNDLE to the runtime bundle directory to run the integration test")
	}
	// A space in the path, like the real ~/Library/Application Support/Waffled.
	data := filepath.Join(t.TempDir(), "Application Support", "Waffled")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := New(Options{BundleDir: bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatalf("supervisor.New: %v", err)
	}
	return s, data
}

type tw struct{ t *testing.T }

func (w *tw) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// TestSnapshotIsTakenAndRolledBackWhenTheAPIFailsToStart is the whole point of the
// pre-migration snapshot: a schema change that leaves the api unable to start must undo
// itself rather than leaving a household with a database their build cannot serve.
//
// The shape is: bring the stack up normally (first run — no snapshot, nothing to lose),
// write a row, then force a second start to believe migrations are pending and make the
// api's health gate fail. The row must survive, because the snapshot taken on the way in
// is restored on the way out.
func TestSnapshotIsTakenAndRolledBackWhenTheAPIFailsToStart(t *testing.T) {
	s, data := integrationSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s.Stop(stopCtx)
	})

	if err := s.Start(ctx); err != nil {
		t.Fatalf("first start: %v", err)
	}
	db := s.plan.Env.PostgresDB()

	// A first run must NOT have snapshotted: there was nothing to roll back to, and a
	// dump of an empty database is theatre that costs every new install time.
	if snaps := snapshotFiles(t, data); len(snaps) != 0 {
		t.Errorf("a first start took a snapshot it did not need: %v", snaps)
	}

	// Something recognisable to prove survived the rollback.
	const canary = "rollback-canary"
	if _, err := s.QueryScalar(ctx, db,
		"create table if not exists rollback_probe (note text); "+
			"insert into rollback_probe values ('"+canary+"')"); err != nil {
		t.Fatalf("write the canary row: %v", err)
	}

	stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
	if err := s.Stop(stopCtx); err != nil {
		t.Fatalf("stop before the failing start: %v", err)
	}
	c()

	// ── rewind one migration, for real ──────────────────────────────────────────
	//
	// The database is genuinely put back to the state before 0096_recipe_views by running
	// that migration's own Down SQL and removing its pgmigrations row. `start` compares
	// the bundle's migration NAMES against that table, so the bundle now ships one the
	// database has not got — which is exactly what a real upgrade looks like.
	//
	// It has to be a real rewind rather than only deleting the row: node-pg-migrate would
	// otherwise re-run an Up whose objects still exist, and the migration would fail
	// before the api ever started, so nothing would reach the health gate this test is
	// about. 0096 is the right one to pick — a leaf table nothing else in the bundle
	// references, with a Down migration that fully undoes it.
	const rewound = "0096_recipe_views"

	s2, err := New(Options{BundleDir: s.plan.Bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	pgStop, err := s2.ensurePostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s2.QueryScalar(ctx, db,
		"drop index if exists ix_recipe_views_household_viewed; "+
			"drop index if exists uq_recipe_views_person_recipe; "+
			"drop table if exists recipe_views; "+
			"delete from pgmigrations where name = '"+rewound+"'"); err != nil {
		t.Fatalf("rewind %s: %v", rewound, err)
	}
	t.Logf("rewound the database to before %s", rewound)
	pgStop()

	// The api's health gate fails, as it would if the migration had broken it. Every
	// other step — the snapshot, the migration, launching the api — runs for real.
	s3, err := New(Options{BundleDir: s.plan.Bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	s3.waitHealthy = func(ctx context.Context, url string, timeout time.Duration, alive func() error) error {
		if strings.Contains(url, "/healthz") && strings.Contains(url, fmt.Sprintf(":%d", s3.plan.Ports.API)) {
			return fmt.Errorf("forced failure: the api is not healthy after migrating")
		}
		return waitHTTP(ctx, url, timeout, alive)
	}
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s3.Stop(stopCtx)
	})

	startErr := s3.Start(ctx)
	if startErr == nil {
		t.Fatal("the start succeeded despite a failing api health gate")
	}
	// The message has to name the snapshot: someone reading this in a log needs the file.
	snaps := snapshotFiles(t, data)
	if len(snaps) != 1 {
		t.Fatalf("expected exactly one pre-migration snapshot, got %v", snaps)
	}
	if !strings.Contains(startErr.Error(), filepath.Base(snaps[0])) {
		t.Errorf("the failure does not name the snapshot it restored (%s):\n%v",
			filepath.Base(snaps[0]), startErr)
	}
	if !strings.Contains(startErr.Error(), "rolled back") {
		t.Errorf("the failure does not say the database was rolled back:\n%v", startErr)
	}

	// ── the data survived ───────────────────────────────────────────────────────
	pgStop2, err := s3.ensurePostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer pgStop2()

	got, err := s3.QueryScalar(ctx, db, "select note from rollback_probe")
	if err != nil {
		t.Fatalf("the canary table did not survive the rollback: %v", err)
	}
	if strings.TrimSpace(got) != canary {
		t.Errorf("canary = %q, want %q — the rollback did not restore the pre-migration data",
			strings.TrimSpace(got), canary)
	}

	// The schema is back at the PRE-migration state specifically, not merely at some
	// state: the migration that was pending is pending again, and the table it creates is
	// gone. Restoring anything else would mean the snapshot had been taken at the wrong
	// moment — after the migration rather than before it — which is the failure that
	// would make this whole mechanism useless while still looking like it worked.
	applied, err := s3.appliedMigrations(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	bundled, err := s3.bundleMigrations()
	if err != nil {
		t.Fatal(err)
	}
	pending := backup.Pending(bundled, applied)
	if len(pending) != 1 || pending[0] != rewound {
		t.Errorf("after the rollback the pending migrations are %v, want exactly [%s] — "+
			"the snapshot must capture the database as it was BEFORE migrating", pending, rewound)
	}
	exists, err := s3.QueryScalar(ctx, db, "select to_regclass('public.recipe_views') is not null")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(exists) != "f" {
		t.Error("recipe_views exists after the rollback — the snapshot was taken after the " +
			"migration ran, not before it")
	}
}

// TestBackupWorksWithTheServerStopped pins the decision documented in ensurePostgres:
// `backup` starts Postgres for itself rather than refusing, because the nightly launchd
// job runs on Macs where nobody has the server up.
func TestBackupWorksWithTheServerStopped(t *testing.T) {
	s, data := integrationSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s.Stop(stopCtx)
	})

	if err := s.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
	if err := s.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	c()
	if _, running := s.postgresPid(); running {
		t.Fatal("postgres is still running after stop; this test needs it down")
	}

	s2, err := New(Options{BundleDir: s.plan.Bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	path, err := s2.Backup(ctx, BackupOptions{})
	if err != nil {
		t.Fatalf("backup with the server stopped: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the dump was not written: %v", err)
	}
	if st.Size() == 0 {
		t.Error("the dump is empty")
	}
	// The machine must be left as it was found: a postmaster left listening would
	// collide with the next real start, and on the nightly path nobody would notice.
	if _, running := s2.postgresPid(); running {
		t.Error("backup left postgres running after starting it itself")
	}
	// No half-written file may survive under the final name or the temporary one.
	if _, err := os.Stat(path + ".part"); err == nil {
		t.Error("a .part file was left behind")
	}
	// The sidecar is what makes a dump's level readable without unpacking it.
	side, ok := backup.ReadSidecar(path)
	if !ok {
		t.Fatal("no sidecar was written beside the dump")
	}
	if side.Migration == "" || side.Database != s2.plan.Env.PostgresDB() {
		t.Errorf("the sidecar does not describe the dump: %+v", side)
	}
	if side.Collation == "" {
		t.Error("the sidecar records no collation, which is what a cross-machine restore needs")
	}
}

func snapshotFiles(t *testing.T, data string) []string {
	t.Helper()
	dir := filepath.Join(data, "backups")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if backup.IsSnapshot(e.Name()) {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out
}
