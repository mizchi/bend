// Feasibility probe only: this is not a Bend evaluator or generated program.
struct Queue {
  reservations: atomic<u32>,
  overflows: atomic<u32>,
  padding: vec2<u32>,
  items: array<vec4<u32>>,
}

@group(0) @binding(0) var<storage, read> inputs: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read_write> queue: Queue;
@group(0) @binding(2) var<storage, read_write> results: array<vec4<u32>>;

@compute @workgroup_size(64)
fn produce(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&inputs)) { return; }
  let slot = atomicAdd(&queue.reservations, 1u);
  if (slot >= arrayLength(&queue.items)) {
    atomicAdd(&queue.overflows, 1u);
    return;
  }
  // The counter reserves a unique slot; it does NOT publish this payload.
  queue.items[slot] = vec4<u32>(id.x, inputs[id.x].xy, 0u);
}

@compute @workgroup_size(64)
fn consume(@builtin(global_invocation_id) id: vec3<u32>) {
  // The host starts a separate compute pass after every producer has finished.
  // No invocation spins on another workgroup or consumes a half-written Term.
  let count = min(atomicLoad(&queue.reservations), arrayLength(&queue.items));
  if (id.x >= count) { return; }
  let item = queue.items[id.x];
  let word = item.yz;
  let sum = word_add(word, inputs[item.x].zw);
  let loc = term_loc(word);
  let packed = term_pack(term_tag(word), term_aux(word), loc, term_rfc(word));
  results[item.x * 3u] = vec4<u32>(packed, sum);
  results[item.x * 3u + 1u] = vec4<u32>(term_tag(word), term_aux(word), loc);
  results[item.x * 3u + 2u] = vec4<u32>(term_rfc(word), 1u, 0u, 0u);
}
