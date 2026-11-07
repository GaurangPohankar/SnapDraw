import { Logo } from "../../components/Logo";

/** Popup masthead: brand mark, wordmark and a single-line tagline. */
export function Header() {
  return (
    <header className="sd-popup__header">
      <Logo size={30} withWordmark />
      <p className="sd-popup__tagline">Capture, annotate, share instantly.</p>
    </header>
  );
}
