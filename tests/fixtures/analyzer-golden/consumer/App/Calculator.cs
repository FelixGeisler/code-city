namespace Golden.Consumer;

public sealed class Calculator
{
    public int Choose(bool first, bool second)
    {
        if (first && second) return 1;
        return first ? 2 : 3;
    }
}
