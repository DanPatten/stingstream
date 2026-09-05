//! uniffi's bindings generator, built from this crate so the generator and the library it reads
//! are always the same version of uniffi.
//!
//! `apps/stingstream/scripts/build-mesh-android.ps1` runs it in library mode against the freshly
//! built `.so`, which is the mode that needs no `.udl` file at all.

fn main() {
    uniffi::uniffi_bindgen_main()
}
