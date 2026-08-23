package loki

// queryRangeResponse mirrors the relevant subset of Loki's
// /loki/api/v1/query_range JSON response.
type queryRangeResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string         `json:"resultType"`
		Result     []streamResult `json:"result"`
	} `json:"data"`
}

// streamResult is one label-set stream with its raw [timestamp, line] pairs.
type streamResult struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

// labelsResponse mirrors /loki/api/v1/labels and /loki/api/v1/label/{name}/values.
type labelsResponse struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

// LabelMatcher is one stream-selector matcher, e.g. namespace="backend".
type LabelMatcher struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Op    string `json:"op"` // "=", "!=", "=~", "!~"
}

// Entry is the clean, flattened log line sent to the frontend. It never
// contains raw Loki JSON — the message has already been extracted.
type Entry struct {
	Timestamp string            `json:"timestamp"`
	Line      string            `json:"line"`
	Labels    map[string]string `json:"labels"`
}
