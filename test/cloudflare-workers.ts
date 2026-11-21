// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
// Tests run in Node; the OAuth library only needs the class to compare against.
export class WorkerEntrypoint {
  constructor(public ctx: unknown, public env: unknown) {}
}
