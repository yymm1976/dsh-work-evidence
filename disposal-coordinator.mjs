/** Coordinate agent and session teardown.
 *  A host may emit `session/disposed` without awaiting the async
 *  `agent/disposed` handler. Deleting runtime state at that point would make
 *  effect-observer recreate a state without its telemetry directory, losing
 *  decisions recorded after the last main request. Sessions that never had an
 *  agent must still be released immediately. */
export function createDisposalCoordinator(dispose){
  const pending=new Map();
  return {
    agentDisposed(id,cleanup){
      const promise=Promise.resolve().then(cleanup).then(
        value=>({ok:true,value}),
        error=>({ok:false,error}));
      pending.set(id,promise);
      void promise.then(()=>{if(pending.get(id)===promise)pending.delete(id);});
      return promise;
    },
    async sessionDisposed(id){
      const active=pending.get(id);
      if(active)await active;
      dispose(id);
    },
    hasPending:id=>pending.has(id),
  };
}
