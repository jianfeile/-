// Settings the seller edits. Nothing here is secret.
window.CIVIQUE_CONFIG = {
  price: '14,99 €',      // shown on the unlock page
  payUrl: '',            // Stripe Payment Link. Set its after-payment redirect to: https://YOUR-SITE/?paid={CHECKOUT_SESSION_ID}
  api: '/api/unlock',    // the site's own function that confirms payments; set to '' on hosting without functions
  contact: '',           // how buyers reach you if something goes wrong, e.g. an email address
  seller: '',            // legal name of the seller, shown at the bottom of the About page
  beacon: ''             // optional counting pixel: the app requests beacon + event name once per device (ten_answers, paywall, unlocked, mini_done, exam_done)
};
