# @unsafe reaches a type through its kind alone: D's and E's kinds call
# Array.join (no def of ours names it), so D and E rely on unsafe, E with
# no constructor for the walk to read, and so does a def whose type names D
import Base

def qsize(j: Array<Nat>) -> Quant:
  match j:
    case ALeaf{value}: &1
    case ANode{xs, ys}: &1

type D is Kind(qsize(Array.join(Nat, ALeaf{0n}, ALeaf{0n}))):
  Mk{}

type E is Kind(qsize(Array.join(Nat, ALeaf{0n}, ALeaf{0n}))):

def use(d: D) -> Nat:
  match d:
    case Mk{}: 0n

def sound(n: Nat) -> Nat:
  n

#|SOME PROOFS FAIL
#|Error: 3 defs rely on unsafe or foreign code:
#|- D
#|- E
#|- use
#|exit 1
