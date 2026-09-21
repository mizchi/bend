/** Tagged word ABI: scalars use two u32 words; bit 31 of high marks a heap node. */
export type Scalar = "U32" | "Nat" | "Bool";
// Value is an erased polymorphic data value, still checked by Bend's frontend.
export type ValueType = Scalar | "Node" | "Value" | "Erased";
export type Word = [number, number];
export type Value = { reg: number; type: ValueType };
export type Call = { name: string; args: number[]; dst: number; gpu?: boolean };
export type Instruction =
  | { op: "text"; dst: number; text: number; next: number }
  | { op: "constant"; dst: number; value: Word; next: number }
  | { op: "primitive"; name: string; dst: number; args: number[]; next: number }
  | {
      op: "construct";
      tag: number;
      fields: number[];
      dst: number;
      next: number;
    }
  | {
      op: "match";
      value: number;
      arms: { tag: number; fields: number[]; next: number }[];
      fallback?: number;
    }
  | { op: "branch"; value: number; zero: number; nonzero: number }
  | { op: "call"; call: Call; next: number; tail: boolean }
  | {
      op: "invoke";
      closure: number;
      argument: number;
      dst: number;
      next: number;
      tail: boolean;
    }
  | { op: "fork"; calls: Call[]; next: number; sequential: number }
  | { op: "effect"; effect: number; args: number[]; dst: number; next: number }
  | { op: "return"; value: number };
export type FunctionIR = {
  name: string;
  params: ValueType[];
  result: ValueType;
  entry: number;
  registers: number;
};
export type ConstructorIR = { name: string; tag: number; fields: ValueType[] };
export type ProgramIR = {
  abi: "bend-webgpu-v4";
  constructors: ConstructorIR[];
  closures: { tag: number; function: string }[];
  effects: { name: string; tag: number }[];
  strings: string[];
  functions: FunctionIR[];
  instructions: Instruction[];
  entry: string;
  output: Scalar | "Unit";
  print: boolean;
};
export type Artifact = {
  host?: import("./upstream.ts").NativeHost;
  abi: ProgramIR["abi"];
  ir: ProgramIR;
  shader: string;
  registers: number;
  maxFork: number;
  maxFields: number;
  provenance: {
    bendCommit: string;
    sourceSha256: string;
    compilerSha256: string;
  };
};

export type GraphNode = { tag: number; fields: Word[] };
export type Graph = { roots: Word[]; nodes: GraphNode[] };
