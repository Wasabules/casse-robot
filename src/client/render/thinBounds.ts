import * as B from "../babylon";

/** La méthode de Babylon qui suit une nouvelle matrice du monde (interne : protégée dans ses types). */
type AfterWorld = { _afterComputeWorldMatrix(this: B.AbstractMesh): void };
const meshOnly = B.AbstractMesh.prototype as unknown as AfterWorld;

/**
 * Un mesh en instances fines dont les instances ne bougent pas les unes par rapport aux autres
 * entre deux changements (les blocs d'un morceau de robot, les patins qui défilent sur leur boucle) :
 * sa boîte, dans son propre repère, ne change qu'avec ses instances, et c'est alors à qui les change
 * de la refaire (`thinInstanceRefreshBoundingInfo`). Babylon la refaisait à chaque nouvelle matrice
 * du monde du mesh, donc à chaque image où le morceau bouge, en parcourant toutes ses instances
 * (`Mesh._afterComputeWorldMatrix`) : ~0,7 ms par image au Dépôt. La boîte dans le monde suit
 * toujours le mesh (celle d'`AbstractMesh`, gardée ici) : la visibilité ne change pas.
 */
export function keepThinBounds(mesh: B.Mesh): void {
  (mesh as unknown as AfterWorld)._afterComputeWorldMatrix = function (this: B.AbstractMesh): void {
    meshOnly._afterComputeWorldMatrix.call(this);
  };
}
