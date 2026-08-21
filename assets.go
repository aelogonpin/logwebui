// Package lokiviews embeds the static frontend (web/) into the compiled
// binary. go:embed paths are resolved relative to this file, which is why
// this lives at the module root next to web/ rather than under cmd/server.
package lokiviews

import "embed"

//go:embed all:web
var WebFiles embed.FS
