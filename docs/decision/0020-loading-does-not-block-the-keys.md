# 0020: Loading does not block the keys

## Context

While a file or the changes were being read, every keypress was refused with a message. On a large repository the changes read can take seconds, which made the whole app feel stuck.

## Decision

Only starting another read is refused while one is running; moving, scrolling and closing keep working throughout. As the mirror of opening them, pressing `d` while the changes are loading cancels the read: the loading state ends immediately and the late git answer is ignored.

## Consequences

- One read at a time is kept, so results can never interleave; it is the _start_ that waits, not the user.
- A cancelled read still finishes inside git before being discarded; nothing is killed mid-flight.
