// Included after upstream-generated C. Owns only the asynchronous host boundary;
// work_loop, task delivery, closures, allocation and reference counting are upstream.
#include <emscripten/emscripten.h>
#define API EMSCRIPTEN_KEEPALIVE
#define HOST_WORDS 1024
#define HOST_TASKS 65536
typedef struct { u32 kind, id, count, error; Term words[HOST_WORDS]; } HostRequest;
static HostRequest host_request;
static Term host_tasks[HOST_TASKS], host_pending;
static u32 host_top, host_phase;
static const unsigned char host_fingerprint[32] = { __FINGERPRINT__ };
static const char host_metadata[] = __METADATA__;
static Env host_env(void) { return (Env){CORPUS, ALC[0]}; }
static void host_push(Term t) {
  if (t == 0) return;
  if (host_top == HOST_TASKS) err_fail("Wasm host task capacity exhausted");
  host_tasks[host_top++] = t;
}
static Term host_apply(Term fun, Term arg) {
  Env e = host_env();
  Loc at = task_node(e, FID_CLO_APPLY, TERM_HOLE, 0, 0);
  e.mem[at] = fun; e.mem[at + 1] = arg;
  return term_tsk(FID_CLO_APPLY, at);
}
API u32 request_ptr(void) { return (u32)(uintptr_t)&host_request; }
API u32 corpus_ptr(void) { return (u32)(uintptr_t)CORPUS; }
API u32 metadata_ptr(void) { return (u32)(uintptr_t)host_metadata; }
API u32 fingerprint_ptr(void) { return (u32)(uintptr_t)host_fingerprint; }
API u32 host_peek(u32 lo, u32 hi) { return (u32)term_peek(host_env(), (Term)lo | ((Term)hi << 32)); }
API void host_keep(u32 lo, u32 hi) {
  host_request.words[HOST_WORDS - 1] = term_keep(host_env(), (Term)lo | ((Term)hi << 32));
}
API void host_seal(u32 lo, u32 hi) {
  Term t = (Term)lo | ((Term)hi << 32);
  host_request.words[HOST_WORDS - 1] = cid_hot((u32)term_aux(t)) ? rfc_seal(host_env(), t) : t;
}
API u32 host_alloc(u32 words) { return (u32)heap_alloc(host_env(), cls_fit(words)); }
API u32 host_array(u32 lo, u32 hi) { return (u32)blk_loc(CORPUS, (Term)lo | ((Term)hi << 32)); }
API void host_drop(u32 lo, u32 hi) { term_drop(host_env(), (Term)lo | ((Term)hi << 32)); }
API void init(void) {
  corpus_setup(false, 1, 0);
  io_stk = pool_stack();
  host_push(term_tsk(MAIN_FID, task_node(host_env(), MAIN_FID, TERM_HOLE, 0, 0)));
}
API void resume(u32 count) {
  Env e = host_env();
  if (count >= HOST_WORDS) err_fail("invalid host result width");
  if (host_request.kind == 1) {
    Loc tail = task_tail(host_pending);
    Term cont = CORPUS[tail];
    u32 idx = (u32)(CORPUS[tail + 1] >> 32) & 0xffff;
    CORPUS[tail] = TERM_HOLE;
    heap_free(e, cls_fit(fid_arity((u32)term_aux(host_pending)) + 2), term_loc(host_pending));
    host_push(task_deliver(CORPUS, cont, idx, host_request.words, count));
  } else if (host_request.kind == 2) {
    Term fields[HOST_WORDS];
    u32 n = cid_arity((u32)term_aux(host_pending));
    spare_free(e, cls_fit(n), ctr_take(e, host_pending, n, fields));
    for (u32 i = 0; i + 1 < n; i++) term_drop(e, fields[i]);
    host_push(host_apply(fields[n - 1], host_request.words[0]));
  } else err_fail("host is not suspended");
  host_pending = 0;
  host_request.kind = 0;
}
API u32 step(u32 budget) {
  Env e = host_env();
  if (host_request.kind) return host_request.kind;
  host_fuel = budget + 1;
  for (u32 turn = 0; turn < budget; turn++) {
    if (root_done(CORPUS)) {
      host_request.count = root_take(CORPUS, host_request.words);
      if (host_phase == 0) {
        if (MAIN_PURE) return 0;
        host_phase = 1;
        host_push(host_apply(host_request.words[0], term_clo(FID_IO_EMIT, 0)));
      } else {
        Term req = host_request.words[0];
        u32 cid = (u32)term_aux(req);
        if (cid == CID_EMIT) { term_drop(e, req); host_request.words[0] = 0; return 0; }
        u32 n = cid_arity(cid);
        if (n >= HOST_WORDS) err_fail("host effect width exhausted");
        Loc at = term_peek(e, req);
        host_pending = req;
        host_request.id = cid;
        host_request.count = cid == CID_HALT ? n : n - 1;
        for (u32 i = 0; i < host_request.count; i++) host_request.words[i] = CORPUS[at + i];
        return host_request.kind = 2;
      }
    }
    Reply reply;
    if (host_yielded) {
      host_yielded = false;
      reply = wl_tab[host_checkpoint.fid](e.mem, e.alc, host_checkpoint.sp,
        host_checkpoint.seq, host_checkpoint.rn, WL_HOST_ARGS);
    } else {
      if (!host_top) err_fail("Wasm host lost its continuation");
      Term t = host_tasks[--host_top];
      u32 fid = (u32)term_aux(t);
      if (fid_bangs(fid)) {
        host_pending = t;
        host_request.id = fid; host_request.count = fid_arity(fid);
        if (host_request.count >= HOST_WORDS) err_fail("host argument width exhausted");
        for (u32 i = 0; i < host_request.count; i++) host_request.words[i] = CORPUS[term_loc(t) + i];
        return host_request.kind = 1;
      }
      reply = work_loop(e, io_stk, t, 0);
    }
    if (host_yielded) return 3;
    if (reply == 0) continue;
    if ((u32)CORPUS[task_tail(reply) + 1] == 0) host_push(reply);
    else {
      Loc at = term_loc(reply);
      for (u32 i = 0; i < fid_arity((u32)term_aux(reply)); i++) {
        Term child = CORPUS[at + i];
        if (term_tag(child) == TAG_TSK) { CORPUS[at + i] = TERM_HOLE; host_push(child); }
      }
    }
  }
  return 3;
}
