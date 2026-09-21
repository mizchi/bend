import Base

def double(n: Nat) -> Nat:
  match n:
    case 0n:
      1n
    case 1n+p:
      +x = double(p)
      Nat.add(x, x)

type Box is Data:
  Box{-ghost: Nat, value: U32}
def read(b: Box) -> U32:
  match b:
    case Box{ghost, value}: value
def main() -> U32:
  read(Box{double(48n), 42})
#|42
