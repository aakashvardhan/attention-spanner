/** Viewfinder corner brackets: the egocentric frame. Purely visual. */
export function Brackets() {
  return (
    <span className="brackets" aria-hidden="true">
      <span className="bracket bracket--tl" />
      <span className="bracket bracket--tr" />
      <span className="bracket bracket--bl" />
      <span className="bracket bracket--br" />
    </span>
  );
}
