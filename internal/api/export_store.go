package api

import (
	"os"
	"sync"
	"time"
)

// exportTTL is how long a finished export's temp file is kept around
// waiting to be downloaded, in case the browser never asks for it (tab
// closed, network drop, etc.) — without this a batch of abandoned
// full-lifecycle exports would leak disk space indefinitely.
const exportTTL = 30 * time.Minute

type exportEntry struct {
	path      string
	createdAt time.Time
}

// exportStore tracks temp files produced by full-lifecycle exports until
// they're downloaded (or expire), so /api/export and /api/export/download
// can be two separate requests instead of one giant streamed response.
type exportStore struct {
	mu    sync.Mutex
	files map[string]exportEntry
}

func newExportStore() *exportStore {
	s := &exportStore{files: make(map[string]exportEntry)}
	go s.cleanupLoop()
	return s
}

func (s *exportStore) put(id, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[id] = exportEntry{path: path, createdAt: time.Now()}
}

// take returns the file path for id and removes it from the store — each
// export can only be downloaded once.
func (s *exportStore) take(id string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.files[id]
	if !ok {
		return "", false
	}
	delete(s.files, id)
	return entry.path, true
}

func (s *exportStore) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.removeExpired()
	}
}

func (s *exportStore) removeExpired() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, entry := range s.files {
		if now.Sub(entry.createdAt) > exportTTL {
			os.Remove(entry.path)
			delete(s.files, id)
		}
	}
}
