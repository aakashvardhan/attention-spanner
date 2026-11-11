//! The brain-dump vault, cryptography in WebCrypto.
//! Byte-compatible with the TypeScript: the same algorithms, parameters and
//! encodings, so a vault made there opens here and the other way round (the
//! e2e test checks both directions).
//!
//! Each entry gets its own AES-GCM key, wrapped with RSA-OAEP; the private key
//! is kept twice, encrypted under the passphrase and the recovery code, each
//! through PBKDF2.

use crate::js::{error, from_js, to_js, Res};
use js_sys::{Array, Object, Promise, Reflect, Uint8Array};
use reader_core::vault::{
    b64, normalize_recovery_code, recovery_code, unb64, Dump, DumpEntry, LockedDump, Sealed, Vault,
    PBKDF2_ITERATIONS,
};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = importKey)]
    fn import_key(
        format: &str,
        data: &JsValue,
        alg: &JsValue,
        extractable: bool,
        usages: &JsValue,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = deriveKey)]
    fn derive_key(
        alg: &JsValue,
        base: &JsValue,
        derived: &JsValue,
        extractable: bool,
        usages: &JsValue,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = generateKey)]
    fn generate_key(alg: &JsValue, extractable: bool, usages: &JsValue)
        -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = exportKey)]
    fn export_key(format: &str, key: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"])]
    fn encrypt(alg: &JsValue, key: &JsValue, data: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"])]
    fn decrypt(alg: &JsValue, key: &JsValue, data: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = wrapKey)]
    fn wrap_key(
        format: &str,
        key: &JsValue,
        wrapping: &JsValue,
        alg: &JsValue,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["crypto", "subtle"], js_name = unwrapKey)]
    #[allow(clippy::too_many_arguments)]
    fn unwrap_key(
        format: &str,
        wrapped: &JsValue,
        unwrapping: &JsValue,
        alg: &JsValue,
        unwrapped_alg: &JsValue,
        extractable: bool,
        usages: &JsValue,
    ) -> Result<Promise, JsValue>;
}

/// A wrong passphrase or recovery code.
const LOCKED_MESSAGE: &str = "That didn't unlock it.";

async fn call(p: Result<Promise, JsValue>) -> Res<JsValue> {
    JsFuture::from(p?).await
}

fn usages(list: &[&str]) -> JsValue {
    list.iter()
        .map(|u| JsValue::from_str(u))
        .collect::<Array>()
        .into()
}

fn bytes(v: &[u8]) -> JsValue {
    Uint8Array::from(v).into()
}

fn to_bytes(buffer: JsValue) -> Vec<u8> {
    Uint8Array::new(&buffer).to_vec()
}

/// A JSON algorithm object with byte fields added (salts and IVs must be typed arrays).
fn alg(base: Value, byte_fields: &[(&str, &[u8])]) -> Res<JsValue> {
    let obj: Object = to_js(&base)?.into();
    for (k, v) in byte_fields {
        Reflect::set(&obj, &JsValue::from_str(k), &bytes(v))?;
    }
    Ok(obj.into())
}

fn random(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    crate::chrome::get_random_values(&mut buf);
    buf
}

fn rsa() -> Value {
    json!({ "name": "RSA-OAEP", "hash": "SHA-256" })
}

async fn secret_key(secret: &str, salt: &[u8]) -> Res<JsValue> {
    let base = call(import_key(
        "raw",
        &bytes(secret.as_bytes()),
        &JsValue::from_str("PBKDF2"),
        false,
        &usages(&["deriveKey"]),
    ))
    .await?;
    let pbkdf2 = alg(
        json!({ "name": "PBKDF2", "hash": "SHA-256", "iterations": PBKDF2_ITERATIONS }),
        &[("salt", salt)],
    )?;
    call(derive_key(
        &pbkdf2,
        &base,
        &to_js(&json!({ "name": "AES-GCM", "length": 256 }))?,
        false,
        &usages(&["encrypt", "decrypt"]),
    ))
    .await
}

async fn seal_with_secret(data: &[u8], secret: &str) -> Res<Sealed> {
    let (salt, iv) = (random(16), random(12));
    let key = secret_key(secret, &salt).await?;
    let out = call(encrypt(
        &alg(json!({ "name": "AES-GCM" }), &[("iv", &iv)])?,
        &key,
        &bytes(data),
    ))
    .await?;
    Ok(Sealed {
        salt: Some(b64(&salt)),
        iv: b64(&iv),
        data: b64(&to_bytes(out)),
    })
}

/// A new vault and the recovery code to write down.
pub async fn create_vault(passphrase: &str) -> Res<(Vault, String)> {
    let gen = alg(
        json!({ "name": "RSA-OAEP", "hash": "SHA-256", "modulusLength": 3072 }),
        &[("publicExponent", &[1, 0, 1])],
    )?;
    let pair = call(generate_key(
        &gen,
        true,
        &usages(&["encrypt", "decrypt", "wrapKey", "unwrapKey"]),
    ))
    .await?;
    let private = Reflect::get(&pair, &"privateKey".into())?;
    let public = Reflect::get(&pair, &"publicKey".into())?;
    let pkcs8 = to_bytes(call(export_key("pkcs8", &private)).await?);
    let code = {
        let r = random(26);
        let mut arr = [0u8; 26];
        arr.copy_from_slice(&r);
        recovery_code(&arr)
    };
    let public_key: Value = from_js(call(export_key("jwk", &public)).await?)?;
    let by_passphrase = seal_with_secret(&pkcs8, passphrase).await?;
    let by_recovery = seal_with_secret(&pkcs8, &normalize_recovery_code(&code)).await?;
    Ok((
        Vault {
            public_key,
            by_passphrase,
            by_recovery,
        },
        code,
    ))
}

/// Seal one entry with the public key: no passphrase needed to write.
pub async fn seal_entry(public_key: &Value, entry: &DumpEntry, id: String) -> Res<LockedDump> {
    let mut jwk = public_key.clone();
    jwk["key_ops"] = json!(["wrapKey"]);
    let public = call(import_key(
        "jwk",
        &to_js(&jwk)?,
        &to_js(&rsa())?,
        false,
        &usages(&["wrapKey"]),
    ))
    .await?;
    let key = call(generate_key(
        &to_js(&json!({ "name": "AES-GCM", "length": 256 }))?,
        true,
        &usages(&["encrypt"]),
    ))
    .await?;
    let iv = random(12);
    let plain = serde_json::to_string(entry).map_err(|e| error(e.to_string()))?;
    let data = call(encrypt(
        &alg(json!({ "name": "AES-GCM" }), &[("iv", &iv)])?,
        &key,
        &bytes(plain.as_bytes()),
    ))
    .await?;
    let wrapped = call(wrap_key("raw", &key, &public, &to_js(&rsa())?)).await?;
    Ok(LockedDump {
        id,
        created_at: entry.created_at,
        wrapped_key: b64(&to_bytes(wrapped)),
        iv: b64(&iv),
        data: b64(&to_bytes(data)),
    })
}

/// The write that finishes first-time setup. If another tab finished first,
/// its vault stands: replacing a vault would make every entry under it
/// unreadable for good.
pub async fn plan_setup(
    stored_vault: Option<Vault>,
    dumps: &[Dump],
    locked: &[LockedDump],
    fresh: Vault,
    current: (DumpEntry, String),
) -> Res<(Vault, Vec<LockedDump>)> {
    let vault = stored_vault.unwrap_or(fresh);
    let mut sealed = Vec::new();
    for d in dumps.iter().filter(|d| d.id != current.1) {
        sealed.push(
            seal_entry(
                &vault.public_key,
                &DumpEntry {
                    text: d.text.clone(),
                    bullets: vec![],
                    created_at: d.created_at,
                },
                d.id.clone(),
            )
            .await?,
        );
    }
    sealed.push(seal_entry(&vault.public_key, &current.0, current.1).await?);
    let ids: Vec<String> = sealed.iter().map(|d| d.id.clone()).collect();
    sealed.extend(locked.iter().filter(|d| !ids.contains(&d.id)).cloned());
    sealed.sort_by_key(|d| std::cmp::Reverse(d.created_at));
    Ok((vault, sealed))
}

/// The private key (non-extractable), or `LOCKED_MESSAGE` for a wrong secret.
pub async fn unlock_vault(vault: &Vault, secret: &str, recovery: bool) -> Result<JsValue, String> {
    let (sealed, typed) = if recovery {
        (&vault.by_recovery, normalize_recovery_code(secret))
    } else {
        (&vault.by_passphrase, secret.to_string())
    };
    let decode = |s: &str| unb64(s).ok_or_else(|| LOCKED_MESSAGE.to_string());
    let salt = decode(sealed.salt.as_deref().unwrap_or(""))?;
    let pkcs8 = async {
        let key = secret_key(&typed, &salt).await?;
        let iv = unb64(&sealed.iv).unwrap_or_default();
        call(decrypt(
            &alg(json!({ "name": "AES-GCM" }), &[("iv", &iv)])?,
            &key,
            &bytes(&unb64(&sealed.data).unwrap_or_default()),
        ))
        .await
    }
    .await
    .map_err(|_| LOCKED_MESSAGE.to_string())?;
    call(import_key(
        "pkcs8",
        &pkcs8,
        &to_js(&rsa()).map_err(|_| "rsa")?,
        false,
        &usages(&["unwrapKey"]),
    ))
    .await
    .map_err(|_| "Couldn't open your dumps.".to_string())
}

async fn open_entry(private: &JsValue, locked: &LockedDump) -> Res<DumpEntry> {
    let wrapped = unb64(&locked.wrapped_key).ok_or_else(|| error("bad key"))?;
    let key = call(unwrap_key(
        "raw",
        &bytes(&wrapped),
        private,
        &to_js(&rsa())?,
        &JsValue::from_str("AES-GCM"),
        false,
        &usages(&["decrypt"]),
    ))
    .await?;
    let iv = unb64(&locked.iv).ok_or_else(|| error("bad iv"))?;
    let data = unb64(&locked.data).ok_or_else(|| error("bad data"))?;
    let plain = call(decrypt(
        &alg(json!({ "name": "AES-GCM" }), &[("iv", &iv)])?,
        &key,
        &bytes(&data),
    ))
    .await?;
    serde_json::from_slice(&to_bytes(plain)).map_err(|e| error(e.to_string()))
}

/// Every entry that opens, newest first; a damaged one is counted, never allowed to hide the rest.
pub async fn open_all(
    private: &JsValue,
    locked: &[LockedDump],
) -> (Vec<(String, DumpEntry)>, usize) {
    let mut opened = Vec::new();
    let mut failed = 0;
    for d in locked {
        match open_entry(private, d).await {
            Ok(e) => opened.push((d.id.clone(), e)),
            Err(_) => failed += 1,
        }
    }
    opened.sort_by_key(|(_, e)| std::cmp::Reverse(e.created_at));
    (opened, failed)
}

/// Dump writes read a list, seal, and write it back; two tabs at once would
/// drop one, so they take turns through a Web Lock every page shares.
pub async fn with_dump_lock<T: 'static>(f: impl std::future::Future<Output = T> + 'static) -> T {
    crate::store::with_lock("dumps", f).await
}
