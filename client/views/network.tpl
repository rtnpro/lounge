{{#each networks}}
<section id="network-{{id}}" class="network foo" data-id="{{id}}" data-nick="{{nick}}" data-options="{{toJSON serverOptions}}">
	{{partial "chan"}}
</section>
{{/each}}
