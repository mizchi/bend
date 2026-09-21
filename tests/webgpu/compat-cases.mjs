export const cases = [
  ...[
    "erased_nat",
    "erased_local",
    "erased_field",
    "erased_indirect",
    "string_length",
    "string_composition",
  ].map((name) => `demos/webgpu/compatibility/${name}.bend`),
  ...[
    "reg/erased_field_call",
    "compile/erased_apply",
    "compile/erased_partial_closure",
    "compile/erased_argument",
    "base/string_ops",
    "base/string_kit",
    "compile/closure_dynamic_apply",
    "reg/closure_capture_once",
    "compile/fork_closure_capture",
  ].map((name) => `tests/${name}.bend`),
];
