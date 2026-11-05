export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Some embedded browsers require the user-gesture fallback below. */
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error("复制失败，请手动选择文本复制。");
  } finally {
    field.remove();
  }
}
