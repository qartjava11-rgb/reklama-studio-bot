function formatPrice(n) {
  return Math.round(n || 0).toLocaleString("uz-UZ") + " so'm";
}
function genId(prefix) {
  return prefix + "-" + Date.now().toString(36).toUpperCase();
}
function nowStr() {
  return new Date().toLocaleString("uz-UZ");
}
module.exports = { formatPrice, genId, nowStr };
