const LegalAcceptance = require('../models/LegalAcceptance');
const legalDocuments = require('./legalDocuments');

// Acceptance status is always computed live from LegalAcceptance — there is
// no cached "accepted" boolean anywhere else that could fall out of sync
// with a document version bump. ToS/Privacy/AUP are tracked per-user (every
// individual, including a teammate invited later, must personally accept —
// the onboarding wizard alone can't guarantee that, since it's per-workspace
// and only the signup creator ever sees it). The DPA is tracked
// per-workspace, satisfied once by whoever holds the Owner role.

async function latestAcceptedVersions(filter) {
  const rows = await LegalAcceptance.find(filter).sort({ createdAt: -1 }).lean();
  const bySlug = {};
  for (const row of rows) {
    if (!(row.documentSlug in bySlug)) bySlug[row.documentSlug] = row; // first hit per slug is the most recent, thanks to the sort
  }
  return bySlug;
}

async function getAcceptanceStatus({ userId, workspaceId, role, actAs = false }) {
  const [personalRows, dpaRow] = await Promise.all([
    latestAcceptedVersions({ userId, documentSlug: { $in: legalDocuments.COMBINED_SLUGS } }),
    LegalAcceptance.findOne({ workspaceId, documentSlug: legalDocuments.DPA_SLUG }).sort({ createdAt: -1 }).lean(),
  ]);

  const combinedDocuments = legalDocuments.COMBINED_SLUGS.map((slug) => {
    const doc = legalDocuments.getDocument(slug);
    const accepted = personalRows[slug];
    const currentVersion = legalDocuments.getCurrentVersion(slug);
    return {
      slug, title: doc.title, currentVersion,
      accepted: !!accepted && accepted.documentVersion === currentVersion,
      acceptedAt: accepted?.createdAt || null,
      acceptedVersion: accepted?.documentVersion || null,
    };
  });
  // actAs: WaFlow staff entered this customer (shared/platformAdmin.js) - nothing is required of that session.
  const requiresCombinedAcceptance = !actAs && combinedDocuments.some((d) => !d.accepted);

  const dpaDoc = legalDocuments.getDocument(legalDocuments.DPA_SLUG);
  const dpaCurrentVersion = legalDocuments.getCurrentVersion(legalDocuments.DPA_SLUG);
  const dpaAccepted = !!dpaRow && dpaRow.documentVersion === dpaCurrentVersion;
  const dpa = {
    slug: legalDocuments.DPA_SLUG, title: dpaDoc.title, currentVersion: dpaCurrentVersion,
    summary: legalDocuments.DPA_SUMMARY,
    accepted: dpaAccepted,
    acceptedAt: dpaRow?.createdAt || null,
    acceptedVersion: dpaRow?.documentVersion || null,
    acceptedByUserId: dpaRow?.userId || null,
  };
  // Only an Owner is ever blocked by the DPA — a non-owner teammate can see
  // its status here but is never required to accept it themselves.
  const requiresDpaAcceptance = !actAs && role === 'owner' && !dpaAccepted;

  return { requiresCombinedAcceptance, requiresDpaAcceptance, combined: { documents: combinedDocuments }, dpa };
}

function refuseActAs() {
  const err = new Error('WaFlow staff cannot accept legal documents on behalf of a customer');
  err.statusCode = 403;
  return err;
}

async function recordCombinedAcceptance({ userId, workspaceId, role, ipAddress, userAgent, actAs = false }) {
  if (actAs) throw refuseActAs();
  const rows = legalDocuments.COMBINED_SLUGS.map((slug) => ({
    workspaceId, userId, documentSlug: slug, documentVersion: legalDocuments.getCurrentVersion(slug),
    flow: 'combined_tos_privacy_aup', ipAddress, userAgent,
  }));
  await LegalAcceptance.insertMany(rows);
  return getAcceptanceStatus({ userId, workspaceId, role });
}

async function recordDpaAcceptance({ userId, workspaceId, role, ipAddress, userAgent, actAs = false }) {
  if (actAs) throw refuseActAs();
  if (role !== 'owner') {
    const err = new Error('Only the workspace Owner can accept the Data Processing Agreement');
    err.statusCode = 403;
    throw err;
  }
  await LegalAcceptance.create({
    workspaceId, userId, documentSlug: legalDocuments.DPA_SLUG,
    documentVersion: legalDocuments.getCurrentVersion(legalDocuments.DPA_SLUG),
    flow: 'dpa', ipAddress, userAgent,
  });
  return getAcceptanceStatus({ userId, workspaceId, role });
}

module.exports = { getAcceptanceStatus, recordCombinedAcceptance, recordDpaAcceptance };
