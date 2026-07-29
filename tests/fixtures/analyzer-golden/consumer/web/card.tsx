// @ts-nocheck -- compiled as a standalone analyzer fixture.
interface Props {
  readonly visible: boolean;
  readonly items: readonly string[];
}

export function Card({ visible, items }: Props) {
  return visible
    ? <section>{items.map((item) => <span>{item}</span>)}</section>
    : null;
}
