export default {
  async fetch() {
    return new Response('nimbus preview worker', {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  },
};
