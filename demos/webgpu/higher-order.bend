import Base

type Bias is Data:
  Bias{amount: U32}

def apply(f: U32 -> U32, x: U32) -> U32:
  f(x)

def add_bias(b: Bias, x: U32) -> U32:
  match b:
    case Bias{amount}:
      U32.add(amount, x)

def make(b: Bias) -> U32 -> U32:
  x => add_bias(b, x)

def mapped(r: Array<U32> & U32) -> U32:
  (a, x) = r
  x

def main() -> IO(Unit):
  do IO<Unit>:
    IO.print(U32.show(apply!(make(Bias{40}), 2)))
    IO.print(U32.show(apply!(U32.add(40), 2)))
    IO.print(U32.show(apply(make!(Bias{40}), 2)))
    IO.print(U32.show(mapped(Array.get(U32, Array.map(U32, U32, U32.inc, Array.new(U32, 2n, 41)), 3))))
