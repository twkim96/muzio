package library

import "sync"

type LibraryEvent struct {
	Revision      uint64      `json:"revision"`
	AffectedTypes []MediaType `json:"affectedTypes"`
	Reason        string      `json:"reason"`
}

type libraryEventBroker struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uint64]chan LibraryEvent
}

func (b *libraryEventBroker) subscribe() (<-chan LibraryEvent, func()) {
	channel := make(chan LibraryEvent, 1)
	b.mu.Lock()
	if b.subscribers == nil {
		b.subscribers = make(map[uint64]chan LibraryEvent)
	}
	b.nextID++
	id := b.nextID
	b.subscribers[id] = channel
	b.mu.Unlock()

	var once sync.Once
	return channel, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subscribers, id)
			b.mu.Unlock()
		})
	}
}

func (b *libraryEventBroker) publish(result ReconciliationResult, reason string) {
	if result.Revision == 0 || len(result.AffectedTypes) == 0 {
		return
	}
	event := LibraryEvent{
		Revision:      result.Revision,
		AffectedTypes: append([]MediaType(nil), result.AffectedTypes...),
		Reason:        reason,
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, channel := range b.subscribers {
		select {
		case channel <- event:
			continue
		default:
		}
		var pending LibraryEvent
		select {
		case pending = <-channel:
		default:
		}
		eventForSubscriber := event
		eventForSubscriber.AffectedTypes = mergeMediaTypes(
			pending.AffectedTypes,
			event.AffectedTypes,
		)
		if pending.Reason != "" && pending.Reason != event.Reason {
			eventForSubscriber.Reason = "multiple"
		}
		select {
		case channel <- eventForSubscriber:
		default:
		}
	}
}

func mergeMediaTypes(left, right []MediaType) []MediaType {
	values := make(map[MediaType]struct{}, len(left)+len(right))
	for _, mediaType := range left {
		values[mediaType] = struct{}{}
	}
	for _, mediaType := range right {
		values[mediaType] = struct{}{}
	}
	return sortedMediaTypes(values)
}
