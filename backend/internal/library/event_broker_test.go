package library

import (
	"testing"
	"time"
)

func TestLibraryEventBrokerPreservesMixedReasonsWhenCoalescing(t *testing.T) {
	var broker libraryEventBroker
	events, unsubscribe := broker.subscribe()
	defer unsubscribe()

	result := ReconciliationResult{
		Revision:      2,
		AffectedTypes: []MediaType{MediaTypeVideo},
	}
	broker.publish(result, "rescan")
	result.Revision++
	broker.publish(result, "thumbnail")

	select {
	case event := <-events:
		if event.Reason != "multiple" {
			t.Fatalf("reason = %q, want multiple", event.Reason)
		}
		if len(event.AffectedTypes) != 1 ||
			event.AffectedTypes[0] != MediaTypeVideo {
			t.Fatalf("affected types = %#v", event.AffectedTypes)
		}
	case <-time.After(time.Second):
		t.Fatal("coalesced event was not delivered")
	}
}
