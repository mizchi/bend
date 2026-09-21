import Base

def args(xs: List<String>) -> IO(Unit):
  match xs:
    case Nil{}:
      IO.print("end")
    case Con{head, tail}:
      do IO<Unit>:
        IO.print(head)
        args(tail)

def show_env(r: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match r:
    case Fail{error}:
      IO.print("missing")
    case Done{value}:
      IO.print(value)

def run(action: IO(U32), next: U32 -> IO(Unit)) -> IO(Unit):
  IO.bind(U32, Unit, action, next)

def main() -> IO(Unit):
  do IO<Unit>:
    IO.write("prefix:")
    IO.print("line")
    IO.print_err("warning")
    xs : List<String> <- IO.args()
    args(xs)
    env : Result<&1, &1, U32 & String, String> <- IO.get_env("BEND_TEST")
    show_env(env)
    n : Nat <- IO.now()
    IO.print(Nat.show(n))
    random : Result<&1, &1, U32 & String, U32> <- IO.random_u32()
    value : U32 <- IO.pass(U32, random)
    IO.print(U32.show(value))
    IO.sleep(1)
    run(IO.pure(U32, 42), x => IO.print(U32.show(x)))
