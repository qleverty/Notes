# Tauri 2 — Шпаргалка команд

## 1. Первый запуск (один раз на проекте)

```bash
npm install              # установить JS зависимости
```

---

## 2. Разработка

```bash
npm run dev              # запустить dev-сервер + нативное окно (hot-reload)
```
> В dev-режиме Tauri читает файлы напрямую из папки (devUrl).
> Изменения в JS/CSS видны сразу, изменения в Rust — после перекомпиляции.

---

## 3. Десктопный билд

```bash
npm run build            # → src-tauri/target/release/bundle/
```
Там появятся: `.exe` (Windows), `.dmg`/`.app` (macOS), `.AppImage`/`.deb` (Linux).

---

## 4. Android

### 4.1 Инициализация (один раз)
```bash
npm run tauri android init
# или: npx tauri android init
```
Это создаёт папку `src-tauri/gen/android/` с Gradle-проектом.

### 4.2 Запуск на эмуляторе / устройстве
```bash
npm run android:dev
```

### 4.3 Создать keystore для подписи (один раз!)
```bash
keytool -genkey -v \
  -keystore ~/my-release-key.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias upload
```
> ⚠️  Сохрани `.jks` файл в надёжном месте — потеряешь, не сможешь обновлять приложение в Google Play!

### 4.4 Прописать ключ в проект
Создать файл `src-tauri/gen/android/keystore.properties`:
```
password=ТвойПароль
keyAlias=upload
storeFile=/полный/путь/до/my-release-key.jks
```
> ⚠️  Этот файл в `.gitignore`! Не коммить его!

### 4.5 Подключить keystore в Gradle
Отредактировать `src-tauri/gen/android/app/build.gradle.kts`.

В начало файла добавить импорт:
```kotlin
import java.io.FileInputStream
```

Перед блоком `android {` добавить:
```kotlin
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = java.util.Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}
```

Внутри блока `android {` добавить:
```kotlin
signingConfigs {
    create("release") {
        keyAlias = keystoreProperties["keyAlias"] as String
        keyPassword = keystoreProperties["password"] as String
        storeFile = file(keystoreProperties["storeFile"] as String)
        storePassword = keystoreProperties["password"] as String
    }
}
buildTypes {
    getByName("release") {
        signingConfig = signingConfigs.getByName("release")
    }
}
```

### 4.6 Собрать подписанный APK/AAB
```bash
# APK (для прямой установки / тестирования)
npm run android:build -- --target aarch64

# Несколько архитектур сразу
npm run android:build -- --target aarch64 --target armv7

# AAB (для Google Play — предпочтительно)
npm run android:build -- --apk  # APK
# AAB генерируется по умолчанию, лежит в:
# src-tauri/gen/android/app/build/outputs/bundle/universalRelease/
```

---

## 5. Добавление новой Rust-команды

1. В `src-tauri/src/lib.rs` добавить функцию:
```rust
#[tauri::command]
fn my_command(param: &str) -> String {
    format!("результат: {}", param)
}
```

2. Зарегистрировать в `invoke_handler`:
```rust
.invoke_handler(tauri::generate_handler![greet, my_command])
```

3. Вызвать из JS:
```js
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("my_command", { param: "привет" });
```

---

## 6. Структура проекта

```
my-app/
├── index.html              ← точка входа фронтенда
├── src/
│   ├── main.js             ← JS логика + invoke() вызовы
│   └── styles.css          ← стили
├── package.json
└── src-tauri/
    ├── tauri.conf.json     ← главный конфиг приложения
    ├── Cargo.toml          ← Rust зависимости
    ├── build.rs            ← не трогать
    ├── src/
    │   ├── lib.rs          ← ВСЯ ЛОГИКА ЗДЕСЬ
    │   └── main.rs         ← не трогать (десктоп-точка входа)
    ├── icons/              ← иконки (генерируются: npx tauri icon)
    ├── capabilities/
    │   └── default.json    ← разрешения команд
    └── gen/                ← авто-генерация (в .gitignore)
        └── android/        ← появляется после android init
```

---

## 7. Полезные мелочи

```bash
# Сгенерировать иконки из одного PNG (1024x1024):
npx tauri icon path/to/icon.png

# Посмотреть все доступные команды CLI:
npx tauri --help

# Обновить Tauri зависимости:
npm run tauri migrate
```
