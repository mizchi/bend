import Base

def double(n: Nat) -> Nat:
  match n:
    case 0n:
      1n
    case 1n+p:
      +x = double(p)
      Nat.add(x, x)

def ignore(-x: Nat) -> U32:
  42

def main() -> U32:
  ignore(double(48n))

#|42
