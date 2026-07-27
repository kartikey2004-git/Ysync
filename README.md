# YSync

A local-first, realtime collaborative rich-text editor built with Conflict-free Replicated Data Types (CRDTs) and WebRTC.

Multiple users can edit the same document at once, with automatic conflict resolution and user-intent preservation — no central server holding the source of truth. The CRDT is a variant of the RGA (Replicated Growable Array) protocol, implemented as a Timestamped Insertion (TI) List that guarantees eventual consistency across all replicas.

For details on the CRDT implementation, see the [documentation](./docs/README.md).

## Key features

- Real-time collaborative editing.
- [Local-first](https://martin.kleppmann.com/papers/local-first.pdf) software implementation.
- Automatic merge conflict resolution using [CRDTs](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type).
- User-intent preservation, drawing inspiration from [Peritext](https://www.inkandswitch.com/peritext/static/cscw-publication.pdf).
- Peer-to-peer architecture using WebRTC.

## Architecture

- **backend/** — a file store server that persists each replica's serialized CRDT to disk, and a signaling server that brokers WebRTC peer connections between editors.
- **frontend/** — a React app embedding a Quill rich-text editor; local edits update the TI List, save to local storage, and propagate to peers over an `RTCDataChannel`.

## Getting started

### Prerequisites

`node` and `npm` are required. Built and tested with node `20.11.1` and npm `10.5.1`.

### Installing dependencies

Install the backend and frontend dependencies by running `npm install` inside the `backend` and `frontend` folders respectively.

### Running test cases

```
npm run --prefix backend test
```

## Usage

Run the following in three separate terminals from the project root:

```
npm run --prefix backend fileserver
```

```
npm run --prefix backend sigserver
```

```
npm run --prefix frontend start
```

Then open two browser tabs at [localhost:3000](http://localhost:3000/). The two editors connect peer-to-peer via WebRTC and exchange local editor operations over the data channel.

## Author

[Kartikey Bhatnagar](https://github.com/kartikey2004-git)
