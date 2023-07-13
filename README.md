# imaginary-faces

I asked [Midjourney](https://midjourney.com/) a simple question:

```
/imagine prompt:"Most stereotypical person in X"
```

Where `X` corresponds to a country. The initial result was then used as the backdrop for the respective country on a map. There were no second attempts or filters applied in the creation of these images.

## Results

To explore the interactive results, click on this link: https://anvaka.github.io/imaginary-faces/

[![preview](https://anvaka.github.io/imaginary-faces/preview.png)](https://anvaka.github.io/imaginary-faces/)

Please be aware that:

1. These images are not depictions of real individuals, and the AI was specifically prompted to generate stereotypical (or biased) images.
2. The generated images are not representative of the diverse and complex populations of each country.
3. This project is a product of curiosity about how a machine learning model might "view" the world.

## Tech stack

Each image was created by manually entering a query for every country. 
The resulting high-definition images amounted to 900MB of disk space, which were then compressed using https://squoosh.app/

The map is rendered using [maplibre](https://maplibre.org/) and [natural earth](https://www.naturalearthdata.com/) data.

Each image is loaded separately into the browser and then cropped to fit the shape of the respective country. As a result, initial loading times may be slightly prolonged, but navigation becomes significantly quicker once all countries are loaded.

## Feedback

Your feedback is invaluable to the improvement of this project. 
If you have any suggestions or comments, please feel free to leave them as an issue here, 
or contact me on Twitter at  https://twitter.com/anvaka

## License

The source code in this project is licensed under MIT license. 