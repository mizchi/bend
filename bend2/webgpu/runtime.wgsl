// Objects and tasks are immutable to other owners during evaluation. Allocation
// consumes pools from the previous round; reclamation publishes the next pools.
const FREE = 0u;
const READY = 1u;
const WAITING = 2u;
const DONE = 3u;
struct Task {
  state: atomic<u32>, depth: u32, sp: u32, joins: u32,
  result: vec2u, padding: vec2u,
  children: array<vec2u, __MAX_FORK__>,
}
struct Frame { pc: u32, destination: u32, regs: array<vec2u, __REGISTERS__>, }
struct Node {
  refs: atomic<u32>, state: atomic<u32>, tag: u32, count: u32,
  fields: array<vec2u, __MAX_FIELDS__>,
}
struct Control {
  created: atomic<u32>, error: atomic<u32>, done: atomic<u32>, ready: atomic<u32>,
  task_cursor: atomic<u32>, task_free: atomic<u32>, heap_cursor: atomic<u32>, heap_free: atomic<u32>,
  allocated: atomic<u32>, reclaimed: atomic<u32>, pad0: u32, pad1: u32,
}
struct Params {
  live: u32, capacity: u32, stack: u32, parallel_depth: u32,
  budget: u32, heap_capacity: u32, task_free: u32, heap_free: u32,
}
@group(0) @binding(0) var<storage, read_write> tasks: array<Task>;
@group(0) @binding(1) var<storage, read_write> frames: array<Frame>;
@group(0) @binding(2) var<storage, read_write> control: Control;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read_write> heap: array<Node>;
@group(0) @binding(5) var<storage, read_write> queues: array<u32>;

fn fail(code: u32) { atomicOr(&control.error, code); }
fn is_node(v: vec2u) -> bool { return (v.y & 0x80000000u) != 0u; }
fn retain(v: vec2u) { if (is_node(v)) { atomicAdd(&heap[v.x].refs, 1u); } }
fn release(v: vec2u) { if (is_node(v)) { atomicSub(&heap[v.x].refs, 1u); } }
fn set_reg(frame: u32, reg: u32, value: vec2u) {
  retain(value);
  release(frames[frame].regs[reg]);
  frames[frame].regs[reg] = value;
}
fn clear_frame(frame: u32) {
  for (var r = 0u; r < __REGISTERS__u; r++) {
    release(frames[frame].regs[r]);
    frames[frame].regs[r] = vec2u(0u);
  }
}
fn allocate_node(tag: u32, count: u32) -> u32 {
  let pos = atomicAdd(&control.heap_cursor, 1u);
  if (pos >= params.heap_free) { fail(16u); return 0xffffffffu; }
  let slot = queues[2u * params.capacity + pos];
  heap[slot].tag = tag;
  heap[slot].count = count;
  atomicStore(&heap[slot].refs, 0u);
  atomicStore(&heap[slot].state, 1u);
  atomicAdd(&control.allocated, 1u);
  return slot;
}
fn node_nullary(tag: u32) -> vec2u {
  let slot = allocate_node(tag, 0u);
  if (slot == 0xffffffffu) { return vec2u(0u); }
  return vec2u(slot, 0x80000000u);
}
fn word_lt(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn nat_add(a: vec2u, b: vec2u) -> vec2u {
  let lo = a.x + b.x;
  let hi = a.y + b.y + select(0u, 1u, lo < a.x);
  if (hi > 65535u) { fail(4u); }
  return vec2u(lo, hi);
}
fn nat_sub(a: vec2u, b: vec2u) -> vec2u {
  if (word_lt(a, b)) { return vec2u(0u); }
  return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x));
}
fn word_shl32(a: vec2u, b: vec2u) -> vec2u {
  if (b.y != 0u || b.x >= 32u) { return vec2u(0u); }
  return vec2u(a.x << b.x, 0u);
}
fn word_shr32(a: vec2u, b: vec2u) -> vec2u {
  if (b.y != 0u || b.x >= 32u) { return vec2u(0u); }
  return vec2u(a.x >> b.x, 0u);
}
fn safe_div(a: u32, b: u32) -> u32 { if (b == 0u) { return 0u; } return a / b; }
fn safe_mod(a: u32, b: u32) -> u32 { if (b == 0u) { return a; } return a % b; }

__TEXT__

@compute @workgroup_size(64)
fn evaluate(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.live) { return; }
  let id = queues[gid.x];
  if (atomicLoad(&tasks[id].state) != READY) { return; }
  release(tasks[id].result);
  tasks[id].result = vec2u(0u);
  for (var fuel = 0u; fuel < params.budget; fuel++) {
    if (atomicLoad(&control.error) != 0u) { return; }
    let base = id * params.stack + tasks[id].sp;
    switch (frames[base].pc) {
      __CASES__
      default: { fail(8u); return; }
    }
  }
}

@compute @workgroup_size(64)
fn join_tasks(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= params.capacity || atomicLoad(&tasks[id].state) != WAITING) { return; }
  for (var j = 0u; j < tasks[id].joins; j++) {
    if (atomicLoad(&tasks[tasks[id].children[j].x].state) != DONE) { return; }
  }
  let base = id * params.stack + tasks[id].sp;
  for (var j = 0u; j < tasks[id].joins; j++) {
    let child = tasks[id].children[j];
    set_reg(base, child.y, tasks[child.x].result);
    release(tasks[child.x].result);
    tasks[child.x].result = vec2u(0u);
    atomicStore(&tasks[child.x].state, FREE);
  }
  atomicStore(&tasks[id].state, READY);
}

@compute @workgroup_size(64)
fn mark_dead(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.heap_capacity) { return; }
  if (atomicLoad(&heap[slot].state) == 1u && atomicLoad(&heap[slot].refs) == 0u) {
    atomicStore(&heap[slot].state, 2u);
  }
}

@compute @workgroup_size(64)
fn recycle(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  // Snapshot marking in the previous pass prevents cascading release races.
  if (slot < params.heap_capacity) {
    if (atomicLoad(&heap[slot].state) == 2u) {
      for (var i = 0u; i < heap[slot].count; i++) { release(heap[slot].fields[i]); }
      atomicStore(&heap[slot].state, 0u);
      atomicAdd(&control.reclaimed, 1u);
    }
    if (atomicLoad(&heap[slot].state) == 0u) {
      let pos = atomicAdd(&control.heap_free, 1u);
      queues[2u * params.capacity + pos] = slot;
    }
  }
  if (slot < params.capacity) {
    let state = atomicLoad(&tasks[slot].state);
    if (state == READY) {
      let pos = atomicAdd(&control.ready, 1u);
      queues[pos] = slot;
    }
    if (state == FREE && slot != 0u) {
      let pos = atomicAdd(&control.task_free, 1u);
      queues[params.capacity + pos] = slot;
    }
  }
}

// Host graph import owns one temporary reference to the response root. This
// pass installs it using the same RC operations as ordinary evaluation.
@compute @workgroup_size(1)
fn resume_effect() {
  let value = vec2u(control.pad0, control.pad1);
  set_reg(tasks[0].sp, tasks[0].padding.x, value);
  release(value);
  release(tasks[0].result);
  tasks[0].result = vec2u(0u);
  atomicStore(&tasks[0].state, READY);
}
