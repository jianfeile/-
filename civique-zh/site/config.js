// Settings the seller edits. Nothing here is secret.
window.CIVIQUE_CONFIG = {
  price: '9,99 €',       // written on the buttons that lead to paying and on the unlock page
  payUrl: '',            // Stripe Payment Link. Set its after-payment redirect to: https://YOUR-SITE/?paid={CHECKOUT_SESSION_ID}
  api: '/api/unlock',    // the site's own function that confirms payments; set to '' on hosting without functions
  contact: '',           // how buyers reach you if something goes wrong. An email address here also makes "这道题有问题？" under each explanation a one-tap error report (it opens an email with the question number filled in); any other text is shown next to the number to copy
  seller: '',            // legal name of the seller, shown at the bottom of the About page
  beacon: ''             // optional counting pixel: the app requests beacon + event name once per device (ten_answers, paywall, unlocked, mini_done, exam_done)
};
