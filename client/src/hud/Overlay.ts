const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Full-screen cinematic typography: hero titles, warning banner, scene labels, end card. */
export class Overlay {
  readonly #hero = $("title-hero");
  readonly #sub = $("title-sub");
  readonly #warning = $("warning");
  readonly #warningText = $("warning-text");
  readonly #scene = $("scene-label");
  readonly #endCard = $("end-card");
  readonly #replayTag = $("replay-tag");
  readonly #cinematicTag = $("cinematic-tag");
  #sceneTimer = 0;

  title(text: string | null, variant: "hero" | "sub" | "warning" | "scene" = "hero"): void {
    if (text === null) {
      this.#hero.classList.remove("show");
      this.#sub.classList.remove("show");
      this.#warning.hidden = true;
      return;
    }
    switch (variant) {
      case "hero":
        this.#hero.textContent = text;
        this.#hero.classList.add("show");
        break;
      case "sub":
        this.#sub.textContent = text;
        this.#sub.classList.add("show");
        break;
      case "warning":
        this.#warningText.textContent = text;
        this.#warning.hidden = false;
        break;
      case "scene":
        this.#scene.textContent = text;
        this.#scene.classList.add("show");
        clearTimeout(this.#sceneTimer);
        this.#sceneTimer = window.setTimeout(() => this.#scene.classList.remove("show"), 3600);
        break;
    }
  }

  endCard(visible: boolean): void {
    this.#endCard.hidden = !visible;
    document.body.classList.toggle("endcard", visible);
  }

  replayTag(visible: boolean): void {
    this.#replayTag.hidden = !visible;
  }

  cinematicLabel(text: string | null): void {
    this.#cinematicTag.hidden = !text;
    this.#cinematicTag.textContent = text ?? "";
  }

  clear(): void {
    this.title(null);
    this.#scene.classList.remove("show");
    this.endCard(false);
    this.cinematicLabel(null);
  }
}
