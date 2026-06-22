// Импортируем invoke из Tauri JS API (автоматически доступен через Tauri)
import { invoke } from "@tauri-apps/api/core";

const btn = document.getElementById("greet-btn");
const input = document.getElementById("name-input");
const responseEl = document.getElementById("response");

btn.addEventListener("click", async () => {
  const name = input.value.trim() || "незнакомец";

  try {
    // Вызываем Rust-команду greet(name) → возвращает String
    const message = await invoke("greet", { name });

    responseEl.textContent = message;
    responseEl.classList.remove("hidden");
  } catch (err) {
    responseEl.textContent = "Ошибка: " + err;
    responseEl.classList.remove("hidden");
  }
});
