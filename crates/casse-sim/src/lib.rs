//! La simulation de Casse-Robot, compilée (temps 4 du plan moteur, docs/architecture.md).
//!
//! Portée depuis le TypeScript de src/shared, module par module, chacun vérifié contre celui-ci
//! (tests/native.test.ts : mêmes entrées, mêmes sorties, au bit près), en commençant par les
//! feuilles (ce qui ne dépend de rien d'autre) pour monter jusqu'au pas de la simulation. Compilée en
//! WebAssembly (npm run native), elle est chargée par src/shared/native/native.ts, dans la page, le
//! Worker de la partie solo et le serveur Node.
//!
//! La sonde (fonctionnalités `physics` et `sim`, `npm run native -- --probe`) n'est pas dans le
//! module du jeu : Rapier compilé ici (probe.rs), et la simulation portée, propriétaire de son monde
//! (sim/ : un robot qui roule, vérifié au bit près par tests/nativeSim.test.ts).

pub mod det;
pub mod ffi;
pub mod jsmath;
pub mod navgrid;
#[cfg(feature = "physics")]
pub mod probe;
#[cfg(feature = "sim")]
pub mod sim;
pub mod terrain;
