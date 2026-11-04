<!-- An address with no page. The app bar keeps the one h1, so this heads its own section with an h2. -->
<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
</script>

<section class="view">
	<h2>{page.status}</h2>
	<p>{page.error?.message ?? 'Something went wrong'}</p>
	<p><a href={resolve('/')}>Choose a Water Management Area</a></p>
</section>
